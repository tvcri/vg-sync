# LGL ↔ VG step 7: writes to LGL — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn every `deferred` (to-LGL) decision into an LGL write, sent from the full pass and both checks behind `--write-lgl` and an allow-list, logged in VG's `sync_log`.

**Architecture:** `plan.js` emits LGL writes where it emits `deferred` today. A pure call builder (`lgl-calls.js`) turns a write plus an LGL record into the exact LGL calls. A new apply step (`apply-lgl.js`), called from `apply.js` after the VG writes, re-reads each constituent, drops stale fields, sends the calls, logs them and returns memory rows and holds.

**Tech Stack:** Node ≥ 24, ES modules, `node:test`, no dependencies. LGL REST API v1; VG API (`/sync/log` exists in the app).

**Spec:** `docs/superpowers/specs/2026-11-16-lgl-vg-step7-lgl-writes-design.md` (read it first; it is the authority). Parent: `docs/superpowers/specs/2026-11-11-lgl-vg-sync-design.md`.

## Global Constraints

- This repo is public: no real names, addresses, emails, ids anywhere (code, tests, fixtures, commit messages). Invented people only (Jane Doe; town Zzyzxford, ZIP 00901 for harness addresses; phones 401-555-01xx; emails @example.org).
- Commits end with `Refs #153` and the `Co-Authored-By` line.
- Writes are dry by default: `--write-lgl` (CLI) / `WRITE_LGL=true` (scheduler), and `--write-lgl` requires `--write-vg` (`WRITE_LGL` requires `WRITE_VG`).
- `LGL_WRITE_ALLOW`: comma-separated constituent ids, or `all`; empty/unset means none.
- The service's LGL client never creates or deletes a constituent and never deletes an entry.
- A replaced entry gets `PATCH {not_current: true}`; only the entry the sync read as LGL's value is retired.
- A POST that fails without a response (network error, timeout) is never retried.
- `same` is never logged; `sync_log` rows only for calls sent.
- Hold reasons added: `po-box`, `flapping`, `lgl-refused` (owned); `addressee` (not owned).
- Flapping limit: more than 3 LGL writes for the same person and field in 30 days.
- Log-line interface (`PASS OK`, `CHECK OK`, `SYNC ALIVE`) keeps its existing keys; new keys are appended.
- Never pipe a long run through `tail`; stream or `tee`.

## Review Focus

1. **A constituent edited in LGL between the plan and the write** (cache-planned check, or a slow pass): the field must be skipped `stale`, nothing sent. Test in Task 7 (`stale field is skipped and nothing is sent`).
2. **A couple's shared LGL record** where only one partner changed in VG: no LGL write, `couple` hold on each non-same partner. Test in Task 6 (`couple: one partner changed holds, no LGL write`).
3. **LGL silently storing an email as not current**: the old email must stay current, `lgl-refused` hold opens. Test in Task 7 (`email stored not current keeps the old one and holds`).
4. **A constituent with a Work number beside Home**, or a second Home number: never retired. Test in Task 5 (`only the entry read as LGL's value is retired`).
5. **A run stopped (SIGTERM) mid-way through LGL writes**: the constituent in hand finishes its calls and log append; the next one is not started. Test in Task 7 (`stop between constituents finishes the one in hand`).

---

### Task 1: Comparable form learns every USPS unit word; LGL's default names

**Files:**
- Modify: `src/lgl-vg/fields.js` (UNIT_WORDS near line 130; new exports at the end)
- Test: `test/lgl-vg/fields.test.js`

**Interfaces:**
- Produces: `lglDefaultNames(c) -> { addressee: string, salutation: string }` and `hasDefaultNames(c) -> boolean` in `fields.js`. `c` is an LGL constituent (`prefix`, `first_name`, `last_name`, `suffix`, `addressee`, `salutation`).

- [ ] **Step 1: Write the failing tests**

```js
test('a verification rewrite of the unit designator compares the same', () => {
  const vg = { street: '200 E Randolph St', unit: 'Apartment 5', city: 'Zzyzxford', state: 'RI', zip: '00901' }
  const lgl = { street: '200 E Randolph St', unit: 'Fl 5', city: 'Zzyzxford', state: 'RI', zip: '00901' }
  assert.equal(comparable('address', vg), comparable('address', lgl))
})
test('every USPS secondary unit word is dropped before a designator', () => {
  for (const w of ['apt', 'apartment', 'bldg', 'building', 'dept', 'department', 'fl', 'floor', 'frnt', 'front', 'hngr', 'hangar', 'key', 'lbby', 'lobby', 'lot', 'lowr', 'lower', 'ofc', 'office', 'ph', 'penthouse', 'pier', 'rear', 'rm', 'room', 'side', 'slip', 'spc', 'space', 'stop', 'ste', 'suite', 'trlr', 'trailer', 'unit', 'uppr', 'upper']) {
    assert.equal(comparable('address', { street: '1 Elm St', unit: `${w} 5`, city: 'Zzyzxford', state: 'RI', zip: '00901' }),
      comparable('address', { street: '1 Elm St', unit: '# 5', city: 'Zzyzxford', state: 'RI', zip: '00901' }), w)
  }
})
test('a unit word with no designator after it is kept (Rear Lot Rd is a street)', () => {
  assert.notEqual(comparable('address', { street: '1 Rear Lot Rd', unit: null, city: 'Zzyzxford', state: 'RI', zip: '00901' }),
    comparable('address', { street: '1 Rd', unit: null, city: 'Zzyzxford', state: 'RI', zip: '00901' }))
})
test('lglDefaultNames follows the trial account: suffix period dropped, prefix kept, middle and nickname ignored', () => {
  assert.deepEqual(lglDefaultNames({ first_name: 'Jane', last_name: 'Doe' }), { addressee: 'Jane Doe', salutation: 'Jane' })
  assert.deepEqual(lglDefaultNames({ first_name: 'John', last_name: 'Doe', suffix: 'Jr.' }), { addressee: 'John Doe Jr', salutation: 'John' })
  assert.deepEqual(lglDefaultNames({ prefix: 'Dr.', first_name: 'Jane', middle_name: 'Q', nick_name: 'Jay', last_name: 'Doe' }), { addressee: 'Dr. Jane Doe', salutation: 'Jane' })
})
test('hasDefaultNames is true only when both still match the current name', () => {
  assert.equal(hasDefaultNames({ first_name: 'Jane', last_name: 'Doe', addressee: 'Jane Doe', salutation: 'Jane' }), true)
  assert.equal(hasDefaultNames({ first_name: 'Jane', last_name: 'Doe', addressee: 'Mrs. Jane Doe', salutation: 'Jane' }), false)
  assert.equal(hasDefaultNames({ first_name: 'Jane', last_name: 'Doe', addressee: 'Jane Doe', salutation: 'Dear Friend' }), false)
  assert.equal(hasDefaultNames({ first_name: 'Jane', last_name: 'Doe', addressee: ' Jane  Doe ', salutation: 'Jane' }), true)
})
```

- [ ] **Step 2: Run** `node --test test/lgl-vg/fields.test.js` — Expected: the five new tests FAIL.

- [ ] **Step 3: Implement.** Replace `UNIT_WORDS` with the full USPS Publication 28 Appendix C2 list (abbreviations and spelled-out forms, as in the test). `lglDefaultNames`: join `[prefix, first_name, last_name, suffix with trailing periods removed]`, blanks dropped, single spaces; salutation is `first_name` trimmed. `hasDefaultNames`: compare after trimming and collapsing whitespace, case-sensitive.

- [ ] **Step 4: Run** `npm test` — Expected: all pass.

- [ ] **Step 5: Commit** `git commit -m "Step 7: every USPS unit word compares the same; LGL's default names"`

---

### Task 2: Switches, allow-list and the addressee setting

**Files:**
- Modify: `src/lgl-vg/config.js`, `src/lgl-vg/policy.js`, `src/lgl-vg/main.js` (usage text, `--once` option parsing near lines 78-130), `src/lgl-vg/service.js` (STARTUP line, line 153), `.env.example`
- Test: `test/lgl-vg/config.test.js`, `test/lgl-vg/policy.test.js`, `test/lgl-vg/main.test.js`

**Interfaces:**
- Produces: `config.writeLgl: boolean`, `config.lglWriteAllow: 'all' | Set<string>`; `allowedForLgl(config, constituentId) -> boolean` exported from `config.js`; `opts.writeLgl` on the `--once` commands.

- [ ] **Step 1: Write the failing tests**

```js
// config.test.js
test('WRITE_LGL needs WRITE_VG', () => {
  assert.throws(() => loadConfig({ ...base, WRITE_LGL: 'true' }), /WRITE_LGL=true requires WRITE_VG=true/)
})
test('LGL_WRITE_ALLOW: unset is none, all is all, a list is ids', () => {
  assert.equal(allowedForLgl(loadConfig(base), '101'), false)
  assert.equal(allowedForLgl(loadConfig({ ...base, LGL_WRITE_ALLOW: 'all' }), '101'), true)
  const c = loadConfig({ ...base, LGL_WRITE_ALLOW: ' 101, 202 ' })
  assert.equal(allowedForLgl(c, 101), true)
  assert.equal(allowedForLgl(c, '303'), false)
})
test('LGL_WRITE_ALLOW refuses anything but ids or all', () => {
  assert.throws(() => loadConfig({ ...base, LGL_WRITE_ALLOW: '101,abc' }), /LGL_WRITE_ALLOW/)
})
// policy.test.js
test('lgl-addressee takes if-default or never, and nothing else', () => {
  assert.equal(parsePolicy(JSON.stringify({ settings: { 'lgl-addressee': 'never' } })).setting('lgl-addressee'), 'never')
  assert.throws(() => parsePolicy(JSON.stringify({ settings: { 'lgl-addressee': 'always' } })), /unknown setting value/)
})
// main.test.js
test('--write-lgl without --write-vg is refused', async () => { /* run --once full --write-lgl; expect exit 2 and /--write-lgl requires --write-vg/ */ })
```

- [ ] **Step 2: Run** the three test files — Expected: FAIL.

- [ ] **Step 3: Implement.** `policy.js` checks `lgl-addressee ∈ {if-default, never}` (message `policy: unknown setting value "<v>" for lgl-addressee`). `main.js`: `--write-lgl` on `--once full|vg-check|lgl-check`, usage text updated; passes `writeLgl` alongside `writeVg`. `service.js` STARTUP line gains `write-lgl=on|off allow=<all|n ids|none>`. `.env.example` documents `WRITE_LGL` and `LGL_WRITE_ALLOW`.

- [ ] **Step 4: Run** `npm test` — Expected: all pass.

- [ ] **Step 5: Commit** `git commit -m "Step 7: --write-lgl, WRITE_LGL and LGL_WRITE_ALLOW; lgl-addressee checked"`

---

### Task 3: LGL client writes

**Files:**
- Modify: `src/lgl-vg/lgl.js`
- Test: `test/lgl-vg/lgl.test.js`

**Interfaces:**
- Produces, on the object `createLglClient` returns (each takes `{ attempts }` like the reads; an error has `.status` when LGL answered):
  - `patchConstituent(id, body) -> object`
  - `addEntry(id, kind, body) -> object` (`POST /constituents/{id}/{kind}`)
  - `patchEntry(kind, entryId, body) -> object` (`PATCH /{kind}/{entryId}`)
  - `listEntries(id, kind) -> object[]` (`GET /constituents/{id}/{kind}`, limit 100)
  - `getConstituentFull(id) -> constituent` with `street_addresses`, `email_addresses`, `phone_numbers` filled from `listEntries` (expand answers 403 on this route)
  - `kind ∈ {'street_addresses','email_addresses','phone_numbers'}`; any other throws.

- [ ] **Step 1: Write the failing tests** (fake `fetchImpl`, as the existing tests do)

```js
test('a POST that fails on the network is not retried', async () => { /* fetchImpl throws once; expect addEntry to reject, fetch called once */ })
test('a POST that times out is not retried', async () => { /* AbortSignal timeout; one call */ })
test('a POST answered 429 waits and is retried', async () => { /* 429 with Retry-After: 1, then 200; two calls, sleep(1000) */ })
test('a PATCH that fails on the network is retried like a read', async () => { /* throws, then 200 */ })
test('a write answered 422 throws with status 422, not retried', async () => {})
test('getConstituentFull reads the record and its three lists', async () => { /* four GETs; lists placed on the record */ })
test('an unknown entry kind is refused before any request', () => {})
test('writes send JSON with the auth header', async () => { /* method, Content-Type, body */ })
```

- [ ] **Step 2: Run** `node --test test/lgl-vg/lgl.test.js` — Expected: FAIL.

- [ ] **Step 3: Implement.** Generalize `get` into `request(method, path, { params, body, attempts, timeoutMs })`. Retry rules: 429 and 5xx retried for every method; a thrown fetch (network or timeout) retried only for GET and PATCH. Keep `get` and every existing read's behaviour (the existing tests pin them). The harness's `harness/lgl-write.js` is the model for the call shapes; it stays as it is.

- [ ] **Step 4: Run** `npm test` — Expected: all pass.

- [ ] **Step 5: Commit** `git commit -m "Step 7: LGL client writes; a POST is never retried blind"`

---

### Task 4: VG client: the LGL write log

**Files:**
- Modify: `src/lgl-vg/vg.js`
- Test: `test/lgl-vg/vg.test.js`

**Interfaces:**
- Produces: `vg.appendSyncLog(rows) -> number` (POST `/sync/log` in batches of 500, sum of `appended`); `vg.getSyncLog({ outcome, since, limit = 5000 }) -> SyncLog[]` (GET `/sync/log`, `outcome` repeated).
- Row shape (`SyncLogNew` in the app's OpenAPI): `{ runId, lglConstituentId, personId, field, case, request: { method, path, body }, lglEntryId, oldValue, newValue, outcome, responseStatus, note }`.

- [ ] **Step 1: Failing tests:** `appendSyncLog sends batches of 500 and sums appended`; `getSyncLog sends outcome, since and limit as query`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** with the existing `inBatches` and `get` helpers.
- [ ] **Step 4: Run** `npm test` — pass.
- [ ] **Step 5: Commit** `git commit -m "Step 7: VG client reads and appends the LGL write log"`

---

### Task 5: The call builder

**Files:**
- Create: `src/lgl-vg/lgl-calls.js`
- Test: `test/lgl-vg/lgl-calls.test.js`

**Interfaces:**
- Consumes: `lglFields`, `comparable`, `hasDefaultNames` (Task 1); `PO_BOX` stays in `clean.js`.
- Produces: `buildLglCalls(write, constituent, { addresseeSetting }) -> { calls: Call[], addressee: 'rebuilt' | 'left' | null }`, and `formatCall(call) -> string` (`LGL PATCH /street_addresses/12 {"not_current":true}`).
  - `write` (an LGL write from Task 6): `{ kind: 'lgl', constituentId, personIds: string[], field, case, value, expect, fingerprint, merge: boolean }`. `value` is VG's value in `fields.js` form (`address` `{street, unit, city, state, zip}`; `phones` `{phone, cell}`; `deceased` `{flag, date}`; names a string).
  - `Call`: `{ method, path, body, step: 'set' | 'add' | 'revive' | 'retire', entryKind?, oldEntryId? }`. An `add`'s path is `/constituents/{id}/{kind}`; the `retire` that follows it is known in advance (the old entry's id). A `set` is the one constituent PATCH.

- [ ] **Step 1: Write the failing tests** (invented records; the `con()` helper of `plan.test.js` is the model)

```js
test('a name write sends only the changed key, and empties addressee and salutation when they are LGL\'s default', () => {
  const r = buildLglCalls(w({ field: 'firstName', value: 'Janet' }), con({ addressee: 'Jane Doe', salutation: 'Jane' }), { addresseeSetting: 'if-default' })
  assert.deepEqual(r.calls, [{ method: 'PATCH', path: '/constituents/101', body: { first_name: 'Janet', addressee: '', salutation: '' }, step: 'set' }])
  assert.equal(r.addressee, 'rebuilt')
})
test('a hand-written addressee is left and reported', () => { /* addressee 'Mrs. Jane Doe' -> body { first_name } only, addressee 'left' */ })
test('lgl-addressee never leaves them and reports nothing', () => { /* addressee null */ })
test('the first name is sent without its (Nick) part', () => { /* value 'Jane (Jay)' -> first_name 'Jane' */ })
test('a nickname write needs no addressee rule', () => { /* nick_name only, addressee null */ })
test('deceased sends the mark and its date', () => { /* { is_deceased: true, deceased_date: '2026-10-01' } */ })
test('a new address is added preferred, then the old one retired', () => {
  // street '1 Elm St' + unit 'Apt 2' -> body.street '1 Elm St\nApt 2', state code, postal_code, street_type_name 'Home', is_preferred true
  // then PATCH /street_addresses/12 { not_current: true }
})
test('VG\'s address already on file as a not-current entry is revived, not added', () => { /* PATCH /street_addresses/13 { not_current: false, is_preferred: true }, then retire 12 */ })
test('an address with no current entry in LGL is added and nothing is retired', () => {})
test('only the entry read as LGL\'s value is retired', () => { /* a Work phone and a second Home beside the preferred Home: only the preferred Home is retired */ })
test('a cell write adds a Mobile entry; it is preferred only if the old cell held the mark or no phone does', () => {
  // Home preferred, Mobile current not preferred: new Mobile sent is_preferred false
  // Mobile preferred: new Mobile sent is_preferred true
  // no phones: is_preferred true
})
test('merge adds VG-only numbers and retires nothing', () => {})
test('an email equal in other capitals is revived, not added', () => {})
test('formatCall prints method, path and JSON body', () => {})
```

- [ ] **Step 2: Run** `node --test test/lgl-vg/lgl-calls.test.js` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement.** The entry to retire is `lglFields(constituent).entryIds[slot]` (`address`, `email`, `phone`, `cell`), so it is exactly the entry the sync read. Find-by-value compares `comparable(field, …)` of each entry of the kind (phones: same type group, mobile per `fields.js`'s `isMobile`; compare `normalized_number`/digits) against VG's value, current or not; the entry being retired is excluded. Phones: one slot at a time, each slot whose number differs; preferred rule from the spec ("Phones"). Name keys: `firstName→first_name`, `lastName→last_name`, `suffix→suffix`, `nickname→nick_name`. The addressee rule runs only for `firstName`, `lastName`, `suffix`.

- [ ] **Step 4: Run** `npm test` — pass.
- [ ] **Step 5: Commit** `git commit -m "Step 7: the LGL call builder"`

---

### Task 6: The plan writes to LGL

**Files:**
- Modify: `src/lgl-vg/plan.js`, `src/lgl-vg/check-plan.js` (`peopleOf`, `planCheck` arguments, `CHANGE_OUTCOMES`), `src/lgl-vg/holds.js` (`OWNED_REASONS`)
- Test: `test/lgl-vg/plan.test.js`, `test/lgl-vg/check-plan.test.js`, `test/lgl-vg/holds.test.js`

**Interfaces:**
- Consumes: `buildLglCalls`, `formatCall` (Task 5); `allowedForLgl` (Task 2).
- Produces:
  - `planLinked({ …existing, lglSend, lglWriteCounts })`. `lglSend: (constituentId) => boolean` (writing on and allowed); default `() => false`. `lglWriteCounts: Map<"personId|field", number>`; default empty. `refusals` now also carries `lgl-refused` holds.
  - The returned plan gains `lglWrites: LglWrite[]` (Task 5's `write` shape) and `counts.lglWritesPlanned`.
  - Decisions: an LGL write that will be sent has `outcome: 'write-lgl'`; one that will not has `outcome: 'deferred'` with `note: 'write-lgl off'` or `'not-allowed'`. Both carry `calls: string[]` (from `formatCall`, built against the planned record).
  - `counts.peopleChanged` (pass) and `breakerPeople` / `peopleChanged` (check) include the `personIds` of `lglWrites` that will be sent.
  - `planCheck({ …existing, lglSend, lglWriteCounts })` passes both through.

- [ ] **Step 1: Write the failing tests**

```js
test('vg-changed email with LGL writing on plans an LGL write, not deferred', () => { /* outcome 'write-lgl', lglWrites[0].value === VG's email, expect === LGL comparable */ })
test('with LGL writing off the same write is deferred, with its calls printed', () => { /* note 'write-lgl off', calls[0] starts 'LGL POST /constituents/101/email_addresses' */ })
test('a constituent not on the allow-list is deferred not-allowed', () => {})
test('never-agreed address to-lgl replacing a PO box is held po-box', () => {})
test('toward-deceased with VG deceased and LGL not plans an LGL write of the mark', () => {})
test('to-lgl-else-hold with VG empty still holds never-agreed', () => {})
test('merge plans the VG write and an LGL write of VG-only numbers, and records no memory row', () => {})
test('a field written to LGL more than 3 times in 30 days is held flapping', () => { /* lglWriteCounts '7|email' = 4 */ })
test('3 writes is not flapping', () => {})
test('an open or dismissed lgl-refused hold with the same fingerprint suppresses the write and is desired again', () => {})
test('lgl-refused fingerprint is the write attempted: field and VG comparable value', () => {})
test('couple: both partners changed to the same value writes LGL once with both person ids', () => {})
test('couple: one partner changed holds, no LGL write', () => {})
test('couple names and deceased are never written to LGL', () => {})
test('people changed counts LGL writes that will be sent, not deferred ones', () => {})
// holds.test.js
test('po-box, flapping and lgl-refused are owned; addressee is not', () => {})
// check-plan.test.js
test('breakerPeople counts sent LGL writes', () => {})
test('foundChange is true for a write-lgl decision', () => {})
```

- [ ] **Step 2: Run** the three files — Expected: FAIL.

- [ ] **Step 3: Implement.** In `planLinked`'s per-field loop, replace each `outcome: 'deferred'` with a call to one helper `lglWrite(dec, r, { value, merge })` that applies, in order: `lgl-refused` suppression (re-desire the hold, as `write()` does for `vg-refused`), `flapping` (count `> 3`), `po-box` (address field, LGL's current value's street matches `PO_BOX`), then emits the write and the decision. Couples: compute once per shared field, before the per-person loop, whether every partner's case is `vg-changed` or `both-changed` with one comparable VG value; if so, one write with all `personIds`; otherwise the existing `couple` hold. The `merge` branch emits its LGL half with `merge: true` and pushes no agree row for either half. Add `'write-lgl'` to `CHANGE_OUTCOMES`. Holds: add `po-box`, `flapping`, `lgl-refused` to `OWNED_REASONS`.

- [ ] **Step 4: Run** `npm test` — pass. Existing tests that asserted `deferred` for these cases keep passing with the default `lglSend` (off).
- [ ] **Step 5: Commit** `git commit -m "Step 7: the plan writes to LGL; po-box, flapping, lgl-refused and couple rules"`

---

### Task 7: Applying LGL writes

**Files:**
- Create: `src/lgl-vg/apply-lgl.js`
- Modify: `src/lgl-vg/apply.js` (after the donor writes, before `applyUnlinked`)
- Test: `test/lgl-vg/apply-lgl.test.js`, `test/lgl-vg/apply.test.js`

**Interfaces:**
- Consumes: `lgl.getConstituentFull`, `addEntry`, `patchEntry`, `patchConstituent` (Task 3); `vg.appendSyncLog` (Task 4); `buildLglCalls` (Task 5); `plan.lglWrites` (Task 6).
- Produces: `applyLglWrites(writes, { lgl, vg, runId, policy, log, signal }) -> { counts: { written, stale, refused }, agree: SyncField[], holds: Hold[], stopped: boolean }`.
- `applyPlan(plan, { …existing, lgl = null, runId = null, policy = null })`: when `plan.lglWrites` holds writes to send and `lgl` is given, calls `applyLglWrites` with the writes whose decision outcome is `write-lgl`; merges its `agree` into the memory upsert and its `holds` into the desired holds; `counts.lgl = { written, stale, refused }`.

- [ ] **Step 1: Write the failing tests** (fake `lgl` and `vg` recording calls)

```js
test('writes are grouped by constituent, which is read fresh once', () => {})
test('stale field is skipped and nothing is sent', () => { /* fresh LGL comparable != write.expect -> outcome stale, no calls, no log rows */ })
test('a gone constituent (404 on the read) is stale, not a failure', () => {})
test('calls are sent in order; an add\'s new id is what the check reads', () => {})
test('email stored not current keeps the old one and holds', () => { /* add answers not_current true -> no retire call, lgl-refused hold, outcome refused */ })
test('a 422 stops that field\'s calls, logs refused and opens lgl-refused', () => {})
test('a 500 after retries fails the run', () => {})
test('every call sent is logged in one append per constituent, with LGL\'s old value', () => { /* oldValue = fresh lglFields value, newValue = write.value, request = {method,path,body}, responseStatus */ })
test('a failed log append fails the run', () => {})
test('memory: one agreed row per person with VG\'s value and the entry id written', () => {})
test('a merge write records no memory row', () => {})
test('a name written over a hand-written addressee opens an addressee hold, fingerprint the name written', () => {})
test('stop between constituents finishes the one in hand', () => {})
// apply.test.js
test('applyPlan sends LGL writes after VG writes and upserts their memory with the rest', () => {})
test('applyPlan with no lgl client sends nothing to LGL', () => {})
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement** per the spec's "Applying" (steps 1 to 6), "Refusals" and "The log". A field's calls stop at its first refusal; other fields of the same constituent go on. The one fresh record serves every field of that constituent: each field's calls touch only its own entries or its own constituent keys, so one field's write cannot make another's stale. Each name or deceased field is its own `set` PATCH; LGL leaves keys not sent alone.

- [ ] **Step 4: Run** `npm test` — pass.
- [ ] **Step 5: Commit** `git commit -m "Step 7: apply LGL writes: fresh read, stale check, send, log, memory"`

---

### Task 8: Wiring the full pass, the checks and the service

**Files:**
- Modify: `src/lgl-vg/pass.js`, `src/lgl-vg/check.js`, `src/lgl-vg/service.js`, `src/lgl-vg/main.js`, `README.md`
- Test: `test/lgl-vg/pass.test.js`, `test/lgl-vg/check.test.js`, `test/lgl-vg/service.test.js`

**Interfaces:**
- Consumes: everything above.
- Produces: `runFullPass({ …existing, writeLgl })`, `runCheck({ …existing, writeLgl })`; run row `switches: { writeVg, writeLgl }`; `PASS OK` and `CHECK OK` lines gain, after the existing keys, `lgl-writes=<n> lgl-stale=<n> lgl-refused=<n>` (dry: `lgl-writes=<planned>` and zeros).

- [ ] **Step 1: Write the failing tests**

```js
test('full pass: the LGL write log of 30 days is read once and counted per person and field', () => {})
test('full pass: 5000 log rows (the limit) fails the pass safe: cannot count', () => {})
test('full pass: dry with an allow-list prints calls and sends nothing', () => {})
test('full pass: --write-lgl sends allowed writes and records writeLgl true in the run row', () => {})
test('full pass: PASS OK carries lgl-writes, lgl-stale, lgl-refused after the existing keys', () => {})
test('full pass: LGL writes that will be sent count toward the breaker; deferred ones do not', () => {})
test('vg-check: a vg-changed email is written to LGL', () => {})
test('lgl-check: the sync\'s own write comes back as same and writes nothing', () => {})
test('a check planned from the cache (more than 20 touched) skips a field LGL changed since', () => {})
test('service: WRITE_LGL reaches both checks and the full pass', () => {})
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Both callers build `lglSend = (id) => writeLgl && allowedForLgl(config, id)`, read `vg.getSyncLog({ outcome: ['written'], since: <30 days ago> })` before planning (only when `writeLgl`; else an empty map), pass `lgl`, `runId` and `policy` to `applyPlan`, and include `lgl-refused` holds in `refusals`. README: the new switches and the go-live order from the spec.
- [ ] **Step 4: Run** `npm test` — pass.
- [ ] **Step 5: Commit** `git commit -m "Step 7: full pass, checks and service write to LGL behind --write-lgl"`

---

### Task 9: The harness writes and reads LGL back

**Files:**
- Modify: `harness/run.js` (`runPass` argv), `harness/expect.js`, `harness/scenario.js` (expect keys if validated), `.env.harness.example`
- Test: `test/harness/expect.test.js`, `test/harness/run.test.js`

**Interfaces:**
- Produces: harness passes run with `--write-vg --write-lgl`; `.env.harness.example` sets `LGL_WRITE_ALLOW=all`. New expectations:
  - `expect.lglWrites: n` (decisions with outcome `write-lgl`), alongside `writes` and `deferred`;
  - `expect.lgl.addressee`, `expect.lgl.salutation` (plain compare);
  - `expect.lglEntries: { email_addresses: { current: n, total: n }, … }` counts on the constituent as read back.

- [ ] **Step 1: Failing tests** in `test/harness/expect.test.js` for each new expectation (pass and fail cases); in `run.test.js`, the argv carries `--write-lgl`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — pass.
- [ ] **Step 5: Commit** `git commit -m "Step 7: harness runs with --write-lgl and checks LGL's entries and envelope names"`

---

### Task 10: Harness scenarios for writes to LGL

**Files:**
- Modify: `harness/scenarios/emails.js`, `addresses.js`, `phones.js`, `checks.js` (the `deferred` expectations listed in the spec's Testing section)
- Create: `harness/scenarios/to-lgl.js`

- [ ] **Step 1: Take a dev DB snapshot** before the first harness run of this step: `out/dev-vg-before-step7.sql` (as `out/dev-vg-before-step6.sql` was made; see the step 6 handoff).
- [ ] **Step 2: Flip the existing scenarios.** Each `deferred: 1` that is a to-LGL write becomes `lglWrites: 1, deferred: 0` with `lgl: { … }` set to VG's value; each `why` and `since` updated to say step 7. A second full pass after the write expects `lglWrites: 0, writes: 0` (it settled).
- [ ] **Step 3: Write `to-lgl.js`** with the spec's new scenarios, one each, invented people only: `both-changed-vg-wins-old-lgl-value-logged`; `never-agreed-address-replaced-old-entry-not-current`; `vg-address-on-file-not-current-is-revived`; `po-box-in-lgl-is-held`; `deceased-in-vg-is-marked-in-lgl-with-date`; `name-change-rebuilds-default-addressee`; `name-change-leaves-hand-written-addressee-and-holds`; `couple-both-changed-same-writes-once`; `couple-one-changed-is-held`; `malformed-email-stored-not-current-is-held-old-kept`; `home-and-mobile-both-written-neither-ambiguous`; `work-number-beside-home-is-not-retired`; `own-write-comes-back-through-lgl-check-as-same` (runAlone, phases full → edit vg → vg-check → lgl-check expecting `lglWrites: 0, writes: 0`); `lgl-edited-between-plan-and-write-is-stale` (unit-tested if the harness cannot place an edit between plan and write: then mark `known` with that reason); `flapping-is-held` (seed four `written` log rows via the harness DB helper, then a vg edit); `not-on-allow-list-is-deferred` (runAlone with `args` overriding `LGL_WRITE_ALLOW` through the env, or by `--env` of a copy; pick the one `run.js` supports and say so in `why`).
- [ ] **Step 4: Run each new group** with `npm run harness -- --only to-lgl 2>&1 | tee out/harness-step7-to-lgl.log` — Expected: all PASS. A trial-account flake (`Incomplete read …`) is rerun with `--only` before suspecting the code.
- [ ] **Step 5: Run the full set** `npm run harness 2>&1 | tee out/harness-step7-full.log` — Expected: every scenario PASS (44 old, flipped where listed, plus the new ones).
- [ ] **Step 6: Commit** `git commit -m "Step 7: harness scenarios for writes to LGL"`

---

### Task 11: Rehearsal against production LGL (dry) and the close-out docs

**Files:**
- Modify: `docs/superpowers/specs/2026-11-16-lgl-vg-step7-lgl-writes-design.md` ("What the rehearsal showed"), `docs/superpowers/specs/2026-11-11-lgl-vg-sync-design.md` (Build order step 7; "Testing the write paths" layer 4 per the go-live change), `CLAUDE.md` (status), README
- Create: `docs/handoff-2026-11-NN-go-live.md`

- [ ] **Step 1: Restore a production snapshot into the dev VG** (`vg-utils/mysql-dump`), re-grant the service account (`harness/vg-db.js` grant, then `npm run setup -- --acknowledge-privacy`). Say what is about to run first.
- [ ] **Step 2: Dry full pass against production LGL with the allow-list at all:** `LGL_WRITE_ALLOW=all node src/lgl-vg/main.js --once full --out out/step7-dry 2>&1 | tee out/step7-dry.log` (no `--write-*`). Expected: `PASS OK full dry-run … lgl-writes=<n>`; every planned call printed in the decisions file. Count calls by field and by kind; compare the address count with the 2026-11-11 report's never-agreed addresses. Mask real data when reporting.
- [ ] **Step 3: Restore the harness snapshot** (`out/dev-vg-before-step7.sql`) so the dev DB holds invented data again.
- [ ] **Step 4: Write the close-out:** the rehearsal's results in the step 7 design, the sync design's Build order and go-live, CLAUDE.md status, and the go-live handoff (the spec's Go-live list, with the engineer's go-ahead at each LGL stage).
- [ ] **Step 5: Commit** `git commit -m "Step 7 close-out: rehearsal and go-live handoff"`
