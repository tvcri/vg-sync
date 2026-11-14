# LGL ↔ VG Step 3: Full Pass, LGL to VG — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A full pass, run by hand, that compares every linked pair against the sync memory, decides each field by the policy file, writes LGL's changes and last gift dates to VG, and records memory, holds and a run row in VG — dry by default.

**Architecture:** Pure modules (`policy.js`, the write bodies in `fields.js`, `plan.js`, `holds.js`) turn the pulled data plus memory and holds into a plan. `apply.js` carries the plan out through the VG client, re-reading each person before writing. `pass.js` orchestrates one full pass: read, sanity checks, plan, circuit breaker, apply, run row, one `PASS` line. `main.js` gains a `full` command.

**Tech Stack:** Node 24, ES modules, `node:test`, global `fetch`, no dependencies.

**Spec:** `docs/superpowers/specs/2026-11-11-lgl-vg-sync-design.md` (sections "Checks and the full pass", "Comparing a field", "The policy file", "Guards", "Fields", "LGL's lists", "Couples", "What is stored in VG", "For the customer"). The VG endpoints are those of `tvcri/village-green` PR #155 (`api/source/specification/village-green.yaml`, tag `Sync`, plus `PATCH /persons/{id}`, `PUT /persons/{id}/donor`, `POST /op/geocode/town`).

**Branch:** `lgl-vg-step3`, created from `lgl-vg-step1` (step 1 is not merged to `main`).

## Global Constraints

- This repo is public. Every name, address, email, phone and id in code, tests, fixtures, docs and commit messages is invented (Jane Doe, John Roe, Pat and Lee Doe; `12 Elm St`, Springfield, ZIP `99999`; `@example.org`; `401-555-01xx`). Never copy a value from `out/`, a report, or a sibling project.
- Nothing is written unless asked. Without `--write-vg` a pass writes nothing at all, in VG or anywhere but `out/`: no person, donor, memory, hold or run row.
- Nothing in this step writes to LGL. A decision whose action needs an LGL write is recorded as `deferred` and has no other effect.
- The engineer runs every command that touches LGL or a VG database. Implementers run only the unit tests.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Node 24 built-ins only; no new dependencies.
- `same` is never logged or stored. Memory is stored as the cleaned value, never the comparable form; comparison always recomputes `comparable(field, value)`.
- VG errors carry `status` (existing `httpError` in `vg.js`). A 400, 404 or 422 on a write is a refusal; anything else (5xx, network, 401 after retry, 403) fails the pass.

## Rulings made while writing this plan

These are the planner's calls where the spec or the app PR left a choice. Each is to be added to the design in Task 8.

1. **`sync_log` is for LGL writes only.** The app made it so (`SyncLogNew.request` is required; "the only record of writes to LGL"). VG writes are in `audit_event`. Step 3 writes no log rows; its decisions go to `out/full-<stamp>.jsonl` and the run row's counts.
2. **Actions not built yet are `deferred`.** `to-lgl`, the LGL half of `merge` and `toward-deceased`, and the record action `unlink` are reported and counted, with no memory, hold or write. `unlink` waits for step 4, where merges are looked at.
3. **The flapping guard waits for step 6.** It needs a history of writes in both directions; with VG writes only in `audit_event`, there is none to read yet, and a full pass run by hand cannot flap.
4. **The VG cursor waits for step 6.** The run row records the LGL cursor (five minutes before the newest `updated_at` pulled); `vgCursor` is `null`.
5. **`--snapshot` refuses `--write-vg`.** A stale snapshot reads as `lgl-changed` against newer memory and would write old values into VG.
6. **The command is `full`.** `node src/lgl-vg/main.js full [--write-vg] [--max-people N] [--out dir] [--snapshot file]`. Step 5 adds `--once` and the scheduler.
7. **A couple is decided as a unit per field.** A `to-vg` for a shared field (address, email, phones) is applied to the partners only when no partner's case for that field is `vg-changed`, `vg-cleared`, `both-changed` or `never-agreed`; otherwise every partner whose case is not `same` gets a `couple` hold. Names and deceased for a couple: any case other than `same`, `first-match` or `converged` is a `couple` hold.
8. **Hold reasons.** A policy hold's reason is its case (`never-agreed`, `both-changed`, `lgl-cleared`, `vg-cleared`). Guards: `unclean`, `ambiguous`, `couple`, `lost-nickname`, `deceased-removed`, `phones-no-slot`, `vg-refused`. Records: `no-longer-donor`. Step 3 owns exactly these reasons on holds with a `personId`, and closes only holds it owns; holds from step 4 (unlinked donors) are never touched.
9. **Limits.** `CIRCUIT_BREAKER_PEOPLE` (default 50) and `MAX_CONSTITUENT_DROP_PERCENT` (default 10) in `.env`; `--max-people N` overrides the breaker for one run by hand, for the first live pass.

## Review Focus

1. **A person edited in VG between the read and the write.** Expected: that field is skipped (`stale`), the rest of the person's patch goes ahead, nothing is remembered for the skipped field. Test in Task 6.
2. **A dismissed hold whose values have not changed.** Expected: it stays dismissed and is not reopened, pass after pass; when either value changes it reopens. Test in Task 5.
3. **Holds a later step owns** (no `personId`, or a reason step 3 does not own). Expected: never closed by a full pass. Test in Task 5.
4. **A memory row from an earlier link** (its `lglConstituentId` differs from the person's current link). Expected: ignored, so the field compares as `first-match` or `never-agreed`. Test in Task 4.
5. **A pass that would change more people than the limit**, which the first live pass may do because LGL-only phone numbers are copied to VG. Expected: nothing written, `PASS FAILED` naming the count and the limit, and `--max-people` lets the engineer allow it. Test in Task 7.

---

### Task 1: The policy file

**Files:**
- Create: `policy.json`
- Create: `src/lgl-vg/policy.js`
- Modify: `src/lgl-vg/config.js` (new settings), `.env.example`
- Test: `test/lgl-vg/policy.test.js`, `test/lgl-vg/config.test.js`

**Interfaces:**
- Produces: `parsePolicy(text: string) → Policy`, where `Policy` is `{ fieldAction(field: string, kase: string): Action, record(kind: 'lgl-missing'|'no-longer-donor'): 'hold'|'unlink', setting(name: 'couple-lgl-changed'|'lgl-addressee'): string, hash: string }`. `Action` is one of `to-vg`, `to-lgl`, `hold`, `merge`, `toward-deceased`, `to-lgl-else-hold`.
- Produces: `loadConfig` returns, in addition, `circuitBreakerPeople: number` (default 50), `maxConstituentDropPercent: number` (default 10), `policyFile: string` (default `policy.json`), `imageRevision: string|null` (from `IMAGE_REVISION`).

`policy.json` shape:

```json
{
  "fields": {
    "firstName": { "lgl-changed": "to-vg", "vg-changed": "to-lgl", "both-changed": "to-lgl", "never-agreed": "hold" },
    "...": {}
  },
  "records": { "lgl-missing": "unlink", "no-longer-donor": "hold" },
  "settings": { "couple-lgl-changed": "to-vg", "lgl-addressee": "if-default" },
  "decided": { "fields": "2026-11-12, customer answers to the seven decisions; see the design's For the customer" }
}
```

Field rows, copied from the design's policy table (fields are `firstName`, `lastName`, `suffix`, `nickname`, `address`, `email`, `phones`, `deceased`):

| Field | `lgl-changed` | `vg-changed` | `both-changed` | `never-agreed` |
|---|---|---|---|---|
| firstName, lastName, suffix, nickname | `to-vg` | `to-lgl` | `to-lgl` | `hold` |
| address | `to-vg` | `to-lgl` | `to-lgl` | `to-lgl` |
| email | `to-vg` | `to-lgl` | `to-lgl` | `to-lgl-else-hold` |
| phones | `to-vg` | `to-lgl` | `to-lgl` | `merge` |
| deceased | `to-vg` | `to-lgl` | `to-lgl` | `toward-deceased` |

`lgl-cleared` and `vg-cleared` have no rows anywhere, so they are `hold`.

- [ ] **Step 1: Write the failing tests** in `test/lgl-vg/policy.test.js`:
  - `fieldAction('phones', 'never-agreed')` is `merge` when parsing the real `policy.json` (read it with `readFileSync`).
  - `fieldAction('address', 'lgl-cleared')` is `hold` (no row).
  - `fieldAction('nickname', 'never-agreed')` is `hold`; `fieldAction('deceased', 'never-agreed')` is `toward-deceased`.
  - A field missing from `fields` returns `hold` for every case.
  - `record('lgl-missing')` is `unlink`; `setting('lgl-addressee')` is `if-default`.
  - `parsePolicy` throws a message naming the bad value for: an unknown action (`"copy"`), an unknown field (`"middleName"`), an unknown case (`"lgl-moved"`), an unknown record action, invalid JSON.
  - `hash` is the 64-hex sha256 of the text, and differs for texts that differ only in whitespace.
  - In `config.test.js`: defaults 50, 10, `policy.json`, `null`; `CIRCUIT_BREAKER_PEOPLE=abc` throws naming the variable.
- [ ] **Step 2: Run** `node --test test/lgl-vg/policy.test.js test/lgl-vg/config.test.js` — expect failures (module missing).
- [ ] **Step 3: Implement** `policy.json` with the rows above, `src/lgl-vg/policy.js` (`node:crypto` for the hash), and the four config settings; add them commented to `.env.example`.
- [ ] **Step 4: Run** `npm test` — all pass.
- [ ] **Step 5: Commit** `git add policy.json src/lgl-vg/policy.js src/lgl-vg/config.js .env.example test/lgl-vg/policy.test.js test/lgl-vg/config.test.js && git commit -m "Policy file: the customer's answers as field, record and setting rows"`

### Task 2: VG client — writes and the sync endpoints

**Files:**
- Modify: `src/lgl-vg/vg.js` (update the header comment: it now writes)
- Test: `test/lgl-vg/vg.test.js`

**Interfaces:**
- Produces, on the object `createVgClient` returns (all paths relative to `apiUrl`; batches split into chunks of 500 by the client):
  - `getPerson(personId) → Person` — `GET /persons/{id}?projection=detail`. *Replaced by `getLinkedPersons(lglConstituentId) → PersonSummary[]` (`GET /persons?lglConstituentId=…&projection=detail`) in the review fixes: the single-person endpoint has no `detail` projection.*
  - `patchPerson(personId, body) → Person` — `PATCH /persons/{id}`
  - `putDonor(personId, { lglConstituentId, lastGiftDate }) → Person` — `PUT /persons/{id}/donor`
  - `geocodeTown({ street, city, state, zip }) → { town: string|null }` — `POST /op/geocode/town`
  - `getSyncFields() → SyncField[]` — `GET /sync/fields`
  - `putSyncFields(rows: SyncFieldPut[]) → number` — `PUT /sync/fields`, returns the sum of `upserted`
  - `getSyncHolds(states: string[]) → SyncHold[]` — `GET /sync/holds?state=open&state=dismissed` (repeated `state` params)
  - `createSyncHolds(items: SyncHoldNew[]) → SyncHold[]` — `POST /sync/holds`
  - `patchSyncHolds(items: SyncHoldPatch[]) → number` — `PATCH /sync/holds`, returns the sum of `updated`
  - `startRun({ kind, switches, imageRevision, policyHash }) → SyncRun` — `POST /sync/runs`
  - `finishRun(runId, { result, counts, lglCursor, vgCursor, error }) → SyncRun` — `PATCH /sync/runs/{id}`
  - `lastFullRun() → SyncRun|null` — `GET /sync/runs?kind=full&limit=20`, the newest with `result: "ok"`, else `null`
- Shapes are the PR's `SyncField`, `SyncFieldPut`, `SyncHold`, `SyncHoldNew`, `SyncHoldPatch`, `SyncRun` schemas.

- [ ] **Step 1: Write the failing tests**, with the file's existing `fakeFetch`/`make` helpers:
  - each method sends the method, path, query and JSON body listed above (assert `calls[n].init.method`, `calls[n].url.pathname`, `searchParams.getAll('state')`, `JSON.parse(calls[n].init.body)`);
  - `putSyncFields` with 1,201 rows makes three PUTs of 500, 500 and 201 and returns the summed count;
  - `createSyncHolds` with 501 items returns the 501 rows from two calls, in input order;
  - a 422 from `patchPerson` throws an error with `status === 422`;
  - `lastFullRun` returns the newest `ok` run, skipping a `failed` and a `running` one, and `null` for `[]`.
- [ ] **Step 2: Run** `node --test test/lgl-vg/vg.test.js` — expect failures.
- [ ] **Step 3: Implement** in `vg.js`, reusing `request`.
- [ ] **Step 4: Run** `npm test` — all pass.
- [ ] **Step 5: Commit** `"VG client: person and donor writes, town lookup, sync memory, holds and runs"`

### Task 3: Write bodies and the phone merge

**Files:**
- Modify: `src/lgl-vg/fields.js`
- Test: `test/lgl-vg/fields.test.js`

**Interfaces:**
- Consumes: `lglFields`, `vgFields`, `comparable` (existing).
- Produces:
  - `vgPatch(field, value) → object` — the `PATCH /persons/{id}` properties for one field's LGL value: `firstName`→`{ firstName }`; likewise `lastName`, `suffix`, `nickname`, `email`; `phones`→`{ phone, cell }`; `deceased`→`{ deceased: flag, deceasedDate: flag ? date : null }`; `address`→`{ street, unit, city, state, zip }` (the town is added by `apply.js`).
  - `mergePhones(lgl: {phone,cell}, vg: {phone,cell}) → { value: {phone,cell}, placed: number, unplaced: string[], vgOnly: string[] }` — VG's slots kept; each LGL number whose digits VG lacks goes into the slot of its own LGL label if empty, else the other slot if empty, else into `unplaced`. `vgOnly` is VG numbers LGL lacks (the deferred LGL half). Digits compared as in `comparable('phones')`.
  - `keepsNickname(lglFirst, vgFirst) → boolean` — false when `vgFirst` has a `(…)` part that `lglFirst` lacks.

- [ ] **Step 1: Write the failing tests:**
  - `vgPatch('deceased', { flag: true, date: '2026-01-02' })` → `{ deceased: true, deceasedDate: '2026-01-02' }`; with `flag: false` the date is `null`.
  - `vgPatch('address', { street: '12 Elm St', unit: 'Apt 3', city: 'Springfield', state: 'RI', zip: '99999' })` returns those five keys and no `town`.
  - `mergePhones({ phone: '401-555-0101', cell: null }, { phone: null, cell: '401-555-0102' })` → value `{ phone: '401-555-0101', cell: '401-555-0102' }`, placed 1, unplaced `[]`, vgOnly `['401-555-0102']`.
  - LGL cell `401-555-0103`, VG cell taken and phone empty → goes to VG phone.
  - Both VG slots full with other numbers → LGL number in `unplaced`, value unchanged.
  - The same number with different formatting (`(401) 555-0101` vs `401-555-0101 x12`) counts as present.
  - `keepsNickname('Robert', 'Robert (Bob)')` false; `keepsNickname('Robert (Bob)', 'Robert (Bob)')` true; `keepsNickname('Rob', 'Robert')` true.
- [ ] **Step 2: Run** `node --test test/lgl-vg/fields.test.js` — expect failures.
- [ ] **Step 3: Implement** the three functions.
- [ ] **Step 4: Run** `npm test` — all pass.
- [ ] **Step 5: Commit** `"Fields: VG write bodies, phone merge, nickname check"`

### Task 4: The plan for linked pairs

**Files:**
- Create: `src/lgl-vg/plan.js`
- Test: `test/lgl-vg/plan.test.js`

**Interfaces:**
- Consumes: `classifyDonors` (donors.js), `FIELDS`, `lglFields`, `vgFields`, `comparable`, `vgPatch`, `mergePhones`, `keepsNickname` (fields.js), `compareField` (compare.js), `Policy` (Task 1).
- Produces: `planLinked({ constituents, gifts, persons, memory, refusals, policy, config }) → Plan`
  - `memory`: `SyncField[]` from VG. `refusals`: the open `vg-refused` holds (`SyncHold[]`).
  - `Plan = { decisions: Decision[], writes: Write[], agree: SyncFieldPut[], holds: DesiredHold[], counts: object }`
  - `Decision = { kind: 'field'|'lastGiftDate'|'record', personId, constituentId, field?, case?, action, outcome, lgl?, vg?, note? }` with `outcome` one of `write-vg`, `record`, `hold`, `deferred`. These are the JSON lines of a dry run.
  - `Write = { kind: 'person', personId, constituentId, fields: { [field]: { body: object, expect: string, agree: SyncFieldPut|null } }, address: {street,city,state,zip}|null }` — one per person, all of that person's `to-vg` fields; `expect` is the comparable form of VG's value as read; `agree` is the memory row to upsert after the write (null when the write does not make the two agree, e.g. a merge that leaves VG-only numbers).
    `| { kind: 'donor', personId, constituentId, body: { lglConstituentId, lastGiftDate }, expect: string|null }` — `expect` is the VG last gift date as read.
  - `agree`: memory rows to upsert with no write (`first-match`, `converged`). `value` is LGL's cleaned value; `lglEntryId` is `entryIds.address` / `entryIds.email` for those fields, else `null`.
  - `DesiredHold = { lglConstituentId: string, personId: string, field: string|null, reason: string, fingerprint: string, detail: object }`; `fingerprint` is the first 32 hex of sha256 of `JSON.stringify([lglComparable, vgComparable, agreedComparable ?? null])`, or of `JSON.stringify([kind, constituentId])` for record holds. `detail` holds the LGL and VG values for a person reviewing it.
  - `counts`: pairs, couples, per-case tallies per field, `writesPlanned`, `peopleChanged` (distinct personIds with a write of either kind), `deferred`, `holds`.

The decision for one field of one pair, in order:

1. LGL's value has a problem (`unclean`, `ambiguous`) → hold with that reason.
2. The memory row for `(personId, field)` is used only if its `lglConstituentId` equals the link's; its comparable form is the agreed value.
3. `kase = compareField(...)`. `same` → nothing. `first-match`, `converged` → `agree`.
4. Couple rules (ruling 7) may turn it into a `couple` hold.
5. `action = policy.fieldAction(field, kase)`, then:
   - `to-vg`: guard `lost-nickname` (firstName, `!keepsNickname`) and `deceased-removed` (LGL flag false, VG flag true) → hold; else a write.
   - `merge` (phones): `mergePhones`; unplaced numbers → `phones-no-slot` hold; `placed > 0` → write of the merged value, with `agree` only if the merged value compares equal to LGL's; `vgOnly` non-empty → also a `deferred` decision.
   - `toward-deceased`: LGL marked, VG not → as `to-vg`; otherwise `deferred`.
   - `to-lgl-else-hold`: VG empty → hold `never-agreed`; else `deferred`.
   - `to-lgl` → `deferred`. `hold` → hold with reason `kase`.
6. A planned write for which an open `vg-refused` hold exists with the same fingerprint is not planned; that hold is desired again instead.

Last gift date: for every linked person whose constituent was pulled, if `classifyDonors`'s `lastGiftDate` differs from `person.donor.lastGiftDate`, a `donor` write. Records: a linked constituent missing from the pull → `policy.record('lgl-missing')` (`hold` → hold reason `lgl-missing`, `unlink` → `deferred`); one that fails the donor rule → `policy.record('no-longer-donor')` likewise with reason `no-longer-donor`.

- [ ] **Step 1: Write the failing tests**, with builders for an invented constituent (`con({ id: 101, first_name: 'Jane', last_name: 'Doe', ... })`) and person (`per({ personId: '7', donor: { lglConstituentId: '101', lastGiftDate: '2026-01-05' }, ... })`) and the real `policy.json` parsed. One test per row:
  - no memory, equal values → `agree` row for each field, no write, no hold;
  - memory says `Jane`, LGL now `Janet`, VG `Jane` → person write `{ firstName: 'Janet' }` with `agree.value === 'Janet'`, decision outcome `write-vg`;
  - VG changed only → `deferred`, nothing else;
  - nickname `never-agreed` → hold reason `never-agreed`;
  - email `never-agreed`, VG empty → hold `never-agreed`; VG set → `deferred`;
  - phones `never-agreed`, LGL `401-555-0101`, VG cell `401-555-0102` → write `{ phone: '401-555-0101', cell: '401-555-0102' }`, `agree` null, plus a `deferred` decision;
  - LGL deceased, VG not, never agreed → write `{ deceased: true, deceasedDate: ... }`; VG deceased, LGL not → `deferred`; memory deceased, LGL now not, VG still deceased → `lgl-changed` → hold `deceased-removed`;
  - firstName `lgl-changed` from `Robert` to `Rob` with VG `Robert (Bob)` → hold `lost-nickname`;
  - LGL email `jane@` (unclean) → hold `unclean`, no compare;
  - a memory row with `lglConstituentId: '999'` for a person linked to `101` → treated as no memory (`first-match`);
  - couple (two persons → constituent 101): LGL address changed, both partners at agreed → two writes; one partner's address also changed in VG → `couple` holds, no writes; first names differ (`Pat and Lee` vs `Pat`) → `couple` hold;
  - an open `vg-refused` hold with the same fingerprint → no write, that hold desired again;
  - gift dated after VG's last gift date → `donor` write with the new date; same date → nothing;
  - linked constituent absent → `deferred` (policy `unlink`); constituent no longer a donor → hold `no-longer-donor`;
  - `counts.peopleChanged` counts a person with both a field write and a donor write once.
- [ ] **Step 2: Run** `node --test test/lgl-vg/plan.test.js` — expect failures.
- [ ] **Step 3: Implement** `planLinked`. Group linked persons by constituent first, so couples are decided together.
- [ ] **Step 4: Run** `npm test` — all pass.
- [ ] **Step 5: Commit** `"Plan: decide each linked pair's fields by memory and policy"`

### Task 5: Hold reconciliation

**Files:**
- Create: `src/lgl-vg/holds.js`
- Test: `test/lgl-vg/holds.test.js`

**Interfaces:**
- Consumes: `DesiredHold` (Task 4), `SyncHold` (VG).
- Produces: `OWNED_REASONS: Set<string>` (ruling 8: the four cases, the seven guards, `lgl-missing`, `no-longer-donor`) and `reconcileHolds(desired: DesiredHold[], existing: SyncHold[]) → { open: SyncHoldNew[], patch: SyncHoldPatch[], counts: { opened, seen, changed, reopened, closed, stillDismissed } }`.

Key: `lglConstituentId|personId|field|reason` (`field` null as empty).
- Desired, no existing → `open`.
- Desired, existing open, same fingerprint → patch `{ holdId, seen: true }`; different fingerprint → `{ holdId, seen: true, fingerprint, detail }`.
- Desired, existing dismissed, same fingerprint → nothing (`stillDismissed`); different → `{ holdId, state: 'open', fingerprint, detail }` (reopened).
- Existing open, owned (`personId` set and reason in `OWNED_REASONS`), not desired → `{ holdId, state: 'closed' }`.
- Existing dismissed, not desired → nothing. Not owned → nothing, ever.

- [ ] **Step 1: Write the failing tests**, one per bullet above, plus: an open hold with `personId: null` and reason `name-only` is not closed; an open hold with reason `already-linked-elsewhere` and a personId is not closed; two desired holds with the same key produce one `open`.
- [ ] **Step 2: Run** `node --test test/lgl-vg/holds.test.js` — expect failures.
- [ ] **Step 3: Implement** `reconcileHolds`.
- [ ] **Step 4: Run** `npm test` — all pass.
- [ ] **Step 5: Commit** `"Holds: open, refresh, reopen and close against what the pass found"`

### Task 6: Applying the plan

**Files:**
- Create: `src/lgl-vg/apply.js`
- Test: `test/lgl-vg/apply.test.js`

**Interfaces:**
- Consumes: the Task 2 client methods, `Plan` (Task 4), `reconcileHolds` (Task 5), `vgFields`, `comparable`.
- Produces: `applyPlan(plan, { vg, existingHolds, log }) → { counts: { written, stale, refused, townMissing, memoryUpserted, holds: {...} } }`. `log(decision)` receives one extra decision per write outcome (`outcome: 'written'|'stale'|'refused'`, plus `note: 'town not resolved'` where so).

Order:
1. For each `person` write: `getPerson`; for each planned field, keep it only if `comparable(field, vgFields(fresh)[field]) === expect` (else `stale`). If none left, next. If the kept fields include `address`, call `geocodeTown(address)` and add `town` (`null` when unresolved or the lookup throws a non-pass-failing error; note it). `patchPerson` with the merged body. On a refusal (400/404/422): one `vg-refused` DesiredHold per kept field, fingerprint as planned, `detail.error` the message; no memory. Any other error propagates (the pass fails).
2. For each `donor` write: `getPerson`; skip as `stale` if `fresh.donor?.lastGiftDate ?? null` differs from `expect` or the link changed; else `putDonor`. A refusal opens a `vg-refused` hold with field `lastGiftDate`.
3. `putSyncFields(plan.agree + the agree rows of every field written)`.
4. `reconcileHolds(plan.holds + refusal holds, existingHolds)`; `createSyncHolds(open)`; `patchSyncHolds(patch)`. Empty batches are not sent.

- [ ] **Step 1: Write the failing tests** with a fake `vg` object (plain functions recording calls):
  - a two-field write where VG's email changed since the read → patch contains only the other field, `stale: 1`, and only that field's memory row is upserted;
  - an address write calls `geocodeTown` with the street without the unit, and the patch carries the returned town; a `{ town: null }` result writes `town: null` and counts `townMissing`;
  - `patchPerson` throwing `status: 422` → no memory for its fields, a `vg-refused` hold opened, the next write still made;
  - `patchPerson` throwing `status: 503` → `applyPlan` rejects, no memory or holds sent;
  - a donor write whose fresh last gift date differs from `expect` → not written;
  - no writes, no agree rows, no hold changes → no sync calls at all.
- [ ] **Step 2: Run** `node --test test/lgl-vg/apply.test.js` — expect failures.
- [ ] **Step 3: Implement** `applyPlan`.
- [ ] **Step 4: Run** `npm test` — all pass.
- [ ] **Step 5: Commit** `"Apply: re-read, write to VG, then record memory and holds"`

### Task 7: The full pass and the `full` command

**Files:**
- Create: `src/lgl-vg/pass.js`
- Modify: `src/lgl-vg/main.js` (command `full`; usage text), `README.md` (a "Running a full pass" section), `package.json` (script `"full": "node src/lgl-vg/main.js full"`)
- Test: `test/lgl-vg/pass.test.js`, `test/lgl-vg/main.test.js`

**Interfaces:**
- Consumes: everything above; `createLglClient`, `loadConfig`.
- Produces: `runFullPass({ config, policy, vg, lgl|null, snapshot|null, writeVg: boolean, maxPeople: number|null, now, writeLines(path, lines), stdout, out }) → 0|1`.

Steps, as the design's "A full pass":
1. `vg.whoAmI()`. Read LGL (pull, or the snapshot), `vg.listPersons()`, `vg.getSyncFields()`, `vg.getSyncHolds(['open','dismissed'])`, `vg.lastFullRun()`.
2. Sanity: if the last ok full run's `counts.constituents` exists and this pull has fewer than `(100 − maxConstituentDropPercent)%` of it → fail without writing.
3. `planLinked`. Write the decisions to `${out}/full-<stamp>.jsonl`.
4. Breaker: `counts.peopleChanged > (maxPeople ?? config.circuitBreakerPeople)` → fail without writing, message names both numbers and `--max-people`.
5. If `writeVg`: `startRun({ kind: 'full', switches: { writeVg: true, writeLgl: false }, imageRevision, policyHash })`, `applyPlan`, `finishRun(runId, { result: 'ok', counts, lglCursor, vgCursor: null })`. On an error after `startRun`: `finishRun(... { result: 'failed', error })` (best effort), then fail.
6. Print the summary JSON, then one line: `PASS OK full dry-run|write-vg people=<n> writes=<n> stale=<n> refused=<n> deferred=<n> holdsOpened=<n> holdsClosed=<n> holdsOpen=<n>`, or `PASS FAILED full <message>`.

`lglCursor`: the newest constituent `updated_at` in the pull minus five minutes, ISO; `null` from a snapshot.

`main.js full` options: `--write-vg`, `--max-people N` (positive whole number), `--out dir`, `--snapshot file`. `--snapshot` with `--write-vg` exits 2 with a message (ruling 5). The policy is read from `config.policyFile`.

- [ ] **Step 1: Write the failing tests** with fakes for `vg` and `lgl`:
  - dry run: no `startRun`, `patchPerson`, `putSyncFields`, `createSyncHolds`, `patchSyncHolds` call; decisions file written; last line starts `PASS OK full dry-run`;
  - `writeVg`: `startRun` then writes then `finishRun` with `result: 'ok'` and an `lglCursor` five minutes before the newest `updated_at`;
  - pull of 80 constituents after a last ok full run of 100, limit 10% → `PASS FAILED`, nothing written;
  - plan changing 3 people with `circuitBreakerPeople: 2` → `PASS FAILED full` naming 3 and 2; the same with `maxPeople: 3` → writes;
  - `applyPlan` failing after `startRun` → `finishRun` with `result: 'failed'`, exit 1;
  - in `main.test.js`: `full --snapshot x --write-vg` exits 2; `full --max-people 0` exits 2; usage lists `full`.
- [ ] **Step 2: Run** `node --test test/lgl-vg/pass.test.js test/lgl-vg/main.test.js` — expect failures.
- [ ] **Step 3: Implement** `pass.js` and the command; document it in the README (dry by default, `--write-vg`, `--max-people`, what goes to `out/` and that it holds real data).
- [ ] **Step 4: Run** `npm test` — all pass.
- [ ] **Step 5: Commit** `"Full pass: the full command, sanity checks, circuit breaker and run row"`

### Task 8: Design and handoff

**Files:**
- Modify: `docs/superpowers/specs/2026-11-11-lgl-vg-sync-design.md`

- [ ] **Step 1:** Add the nine rulings above to the design, each in the section it belongs to, marked **(call)**: `sync_log` LGL-only in "What is stored in VG"; deferred actions and unlink in "The policy file"; flapping in "Guards"; the VG cursor in "Checks and the full pass"; snapshot refusal in "Dry run"; the command name in "Dry run"; couples as a unit in "Couples"; hold reasons in "Holds on fields"; the limits' names in "A full pass". Narrow the trial account paragraph in "Testing the write paths": the trial account is for experiments in `spike/` and the step 7 write test, not for runs of the service.
- [ ] **Step 2:** `npm test` — all pass.
- [ ] **Step 3: Commit** `"Design: rulings from the step 3 plan; the trial account's narrower role"`

## After the plan (the engineer, not an implementer)

With the app PR's branch running locally, role 8 granted, and a fresh snapshot restored:

1. `npm run full` — dry run. Read the summary and `out/full-<stamp>.jsonl`.
2. `npm run full -- --write-vg` (with `--max-people` if the breaker trips and the count looks right).
3. `npm run full` again — expect almost everything `same`, no writes, no new holds.
