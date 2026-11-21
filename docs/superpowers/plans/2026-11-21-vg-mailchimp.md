# VG → Mailchimp audience service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A second long-lived service in this repo that, nightly, adds VG's active members, active volunteers and living donors to the Mailchimp audience and archives contacts unsubscribed for 30+ days.

**Architecture:** `src/vg-mailchimp/` is a self-contained executable that shares no code with `src/lgl-vg/` (helpers are copied, never imported). It reads VG through the API as its own read-only service account, reads and writes Mailchimp through a small client, records per-person outcomes to JSONL files on the VM, and prints count-only lines for Log Analytics. It runs in a second compose service from the same image.

**Tech Stack:** Node 24, ES modules, no dependencies, built-in `fetch`, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-21-vg-mailchimp-design.md`. Read it, and `docs/mailchimp-findings-2026-11-11.md`, before any task.

## Global Constraints

- No dependencies. Node ≥ 24. ES modules (`"type": "module"`).
- No import from `src/lgl-vg/` anywhere under `src/vg-mailchimp/`. Copy what is needed.
- The string `delete-permanent` must not appear anywhere under `src/vg-mailchimp/`.
- No `tags` key is ever sent to Mailchimp.
- The VG client issues only `GET`, except `acknowledgePrivacy` (used only by `setup`).
- Never re-add or resubscribe a contact whose status is anything but absent. PUT uses `status_if_new: "subscribed"` only.
- Addresses: `trim().toLowerCase()` before hashing or comparing; subscriber hash = MD5 hex of that.
- Defaults: `ARCHIVE_AFTER_DAYS=30`, `PLAN_LIMIT=5000`, `LIMIT_MARGIN=100`, `MAX_ADD=50`, `MAX_ARCHIVE=50`, `MIN_COHORT=500`, `MAILCHIMP_RUN_UTC=08:00`, `RUN_TIMEOUT_MINUTES=30`, `RECORDS_KEEP_DAYS=30`, `OUT_DIR=out`, `WRITE_MAILCHIMP_ADD=false`, `WRITE_MAILCHIMP_ARCHIVE=false`.
- 300 ms between Mailchimp writes.
- Log line prefixes (exact): `STARTUP `, `STARTUP FAILED `, `MAILCHIMP ALIVE `, `MAILCHIMP OK `, `MAILCHIMP FAILED `, `MAILCHIMP LIMIT `, `MAILCHIMP CAP `, `STOPPING`, `STOPPED`. Service lines are time-stamped as `src/lgl-vg/main.js` `stamped` does.
- No real data in the repo: tests and fixtures use invented people (Jane Doe, `jane@example.org`).
- Repo is worked per `CLAUDE.md`: production Mailchimp reads and writes, and the production VG database, need the engineer's go-ahead per run.

## Review Focus

1. **A 200 that did nothing.** PUT on an archived contact returns 200 with no change. Expected: the read-back sees `archived`, the person is recorded `left-out` / `write-unconfirmed`, never counted as added. Test in Task 7.
2. **A contact resubscribes between the audience pass and the archive.** Expected: the pre-archive re-read sees `subscribed`, records `archive-skipped`, no DELETE. Test in Task 7.
3. **The same address in two cases or with spaces on two persons** (`Jane@Example.org ` and `jane@example.org`). Expected: one candidate, `personIds` holds both, name from the lower id. Test in Task 5.
4. **A dropped member read with `member:read_inactive`** (`memberStatus: 'Dropped'`). Expected: not in the cohort unless volunteer Active or donor. Test in Task 5.
5. **A Mailchimp 429 with `Retry-After`, or a page with no `total_items`.** Expected: 429/5xx retried with backoff up to 4 tries then the run fails; a page without `total_items` throws rather than truncating. Tests in Task 2.

---

## File map

| File | Responsibility |
|---|---|
| `src/vg-mailchimp/config.js` | Env → validated config |
| `src/vg-mailchimp/mailchimp.js` | Mailchimp client: requests, retries, paging, hash |
| `src/vg-mailchimp/mailchimp-mock.js` | `MAILCHIMP_MOCK` state-file fetch, and `openMailchimp` |
| `src/vg-mailchimp/vg.js` | Read-only VG client (Keycloak client credentials) |
| `src/vg-mailchimp/cohort.js` | Persons → candidates and `no-email`/`invalid-email` records |
| `src/vg-mailchimp/decide.js` | Pure: archive selection, classification, billing guard, caps, summary line |
| `src/vg-mailchimp/run.js` | One run: the seven steps, records, snapshot |
| `src/vg-mailchimp/scheduler.js` | Nightly + retries + heartbeat |
| `src/vg-mailchimp/service.js` | Start-up checks, scheduler wiring, pruning |
| `src/vg-mailchimp/main.js` | Command line |
| `test/vg-mailchimp/*.test.js` | One test file per module |
| `docs/vg-mailchimp.1.md`, `deploy/docker-compose.example.yml`, `package.json`, `README.md` | Docs and wiring |

---

### Task 1: Config

**Files:**
- Create: `src/vg-mailchimp/config.js`
- Test: `test/vg-mailchimp/config.test.js`

**Interfaces:**
- Produces: `loadConfig(env = process.env) → Config` where
  `Config = { mailchimp: { apiKey, listId, listName, mock }, vg: { apiUrl, oidcUrl, clientId, clientSecret, scope }, writeAdd, writeArchive, archiveAfterDays, planLimit, limitMargin, maxAdd, maxArchive, minCohort, runUtc, runTimeoutMinutes, recordsKeepDays, outDir, imageRevision }`.

- [ ] **Step 1: Write the failing tests**

```js
// test/vg-mailchimp/config.test.js
const base = { MAILCHIMP_API_KEY: 'k-us1', MAILCHIMP_LIST_ID: 'abc', MAILCHIMP_LIST_NAME: 'Main',
  VG_API_URL: 'https://vg.example.org/api', VG_OIDC_URL: 'https://kc.example.org/realms/vg',
  VG_CLIENT_ID: 'vg-mailchimp', VG_CLIENT_SECRET: 's' }
test('defaults', () => {
  const c = loadConfig(base)
  assert.deepEqual([c.writeAdd, c.writeArchive, c.archiveAfterDays, c.planLimit, c.limitMargin, c.maxAdd, c.maxArchive, c.minCohort, c.runUtc, c.runTimeoutMinutes, c.recordsKeepDays, c.outDir],
    [false, false, 30, 5000, 100, 50, 50, 500, '08:00', 30, 30, 'out'])
  assert.equal(c.vg.scope, 'vg')
})
test('missing variables are named', () => assert.throws(() => loadConfig({}), /MAILCHIMP_API_KEY.*MAILCHIMP_LIST_ID.*MAILCHIMP_LIST_NAME.*VG_API_URL/))
test('MAILCHIMP_MOCK removes the need for an API key', () => {
  const { MAILCHIMP_API_KEY, ...rest } = base
  assert.equal(loadConfig({ ...rest, MAILCHIMP_MOCK: 'mc.json' }).mailchimp.mock, 'mc.json')
})
test('switches are true only for "true"', () => {
  assert.equal(loadConfig({ ...base, WRITE_MAILCHIMP_ADD: 'yes' }).writeAdd, false)
  assert.equal(loadConfig({ ...base, WRITE_MAILCHIMP_ARCHIVE: 'true' }).writeArchive, true)
})
test('bad values are refused', () => {
  assert.throws(() => loadConfig({ ...base, MAILCHIMP_RUN_UTC: '8:00' }), /HH:MM/)
  assert.throws(() => loadConfig({ ...base, LIMIT_MARGIN: '-1' }), /whole number/)
  assert.throws(() => loadConfig({ ...base, RUN_TIMEOUT_MINUTES: '1441' }), /at most 1440/)
  assert.throws(() => loadConfig({ ...base, VG_API_URL: 'http://vg.example.org' }), /https/)
  assert.throws(() => loadConfig({ ...base, LIMIT_MARGIN: '5000' }), /LIMIT_MARGIN must be below PLAN_LIMIT/)
})
```

- [ ] **Step 2: Run** `node --test test/vg-mailchimp/config.test.js`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `loadConfig`** by copying the helpers from `src/lgl-vg/config.js` (`present`, `toUrl`, `toCount`, `toPositive`, `toBounded`, `toClock`). `LIMIT_MARGIN` and `MAX_*` may be 0 (`toCount`); `ARCHIVE_AFTER_DAYS`, `PLAN_LIMIT`, `MIN_COHORT`, `RECORDS_KEEP_DAYS` are positive; `RUN_TIMEOUT_MINUTES` bounded at 1440.

- [ ] **Step 4: Run** the test. Expected: PASS.

- [ ] **Step 5: Commit** `git add src/vg-mailchimp/config.js test/vg-mailchimp/config.test.js && git commit -m "vg-mailchimp: config"`

---

### Task 2: Mailchimp client

**Files:**
- Create: `src/vg-mailchimp/mailchimp.js`
- Test: `test/vg-mailchimp/mailchimp.test.js`

**Interfaces:**
- Produces:
  - `subscriberHash(email: string) → string` (MD5 hex of trimmed, lowercased).
  - `createMailchimpClient({ apiKey, listId, fetchImpl = fetch, sleep, timeoutMs = 60_000, baseUrl }) → client`. `baseUrl` defaults to `https://<dc>.api.mailchimp.com/3.0`, where `dc` is the suffix after the last `-` of the key.
  - `client.getList() → { id, name, stats: { member_count, unsubscribe_count, cleaned_count } }`
  - `client.listMembers() → Array<{ email_address, status, last_changed, merge_fields }>`: all pages of `/lists/{id}/members` with `fields=members.email_address,members.status,members.last_changed,members.merge_fields,total_items`, `count=1000`.
  - `client.getMember(hash) → member | null` (404 → `null`).
  - `client.putMember(hash, { email, firstName, lastName }) → member`: `PUT /lists/{id}/members/{hash}?skip_merge_validation=true` with body `{ email_address, status_if_new: 'subscribed', merge_fields: { FNAME, LNAME } }` (`''` for null names).
  - `client.archiveMember(hash) → void`: `DELETE /lists/{id}/members/{hash}`.
  - Errors carry `status`; a 401 error carries `final: true`.

- [ ] **Step 1: Write the failing tests** with a recording fake `fetchImpl` and `sleep` that records delays:
  - `subscriberHash(' Jane@Example.org ') === subscriberHash('jane@example.org')` and equals the MD5 of `jane@example.org`.
  - The datacenter comes from the key: key `abc-us20` → requests go to `https://us20.api.mailchimp.com/3.0/...`, with `Authorization: Basic base64("anystring:abc-us20")`.
  - `listMembers` pages: fake returns `total_items: 3` across two pages of 2 and 1 → 3 members; offsets requested are `0` and `2`.
  - A page with no `total_items` → throws `/total_items/`.
  - `getMember` on 404 → `null`.
  - `putMember` sends the exact body above, with `skip_merge_validation=true` in the query, and no `tags` key.
  - 429 with header `Retry-After: 2` then 200 → one sleep of 2000 ms, returns the body. Five consecutive 503s → throws after 4 tries (sleeps 1000, 2000, 4000).
  - 401 → throws with `final === true`.
  - Source check: `readFileSync('src/vg-mailchimp/mailchimp.js', 'utf8')` does not include `delete-permanent`.

- [ ] **Step 2: Run** `node --test test/vg-mailchimp/mailchimp.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement** from `mailchimp-poc/mailchimp.mjs` (`mc`, `paginate`, `subscriberHash`), with the request timeout pattern of `src/lgl-vg/vg.js` `timedFetch`. Retry policy: 429 and 5xx and network errors, up to 4 tries; delay is `Retry-After` seconds when present, else 1000 × 2^(try−1).

- [ ] **Step 4: Run** the test. Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "vg-mailchimp: Mailchimp client"` (with both files added).

---

### Task 3: Mailchimp mock

**Files:**
- Create: `src/vg-mailchimp/mailchimp-mock.js`
- Test: `test/vg-mailchimp/mailchimp-mock.test.js`

**Interfaces:**
- Consumes: `createMailchimpClient`, `subscriberHash` (Task 2).
- Produces:
  - `createMockMailchimpFetch({ state, persist, now = Date.now }) → fetchImpl`. `state = { list: { id, name }, members: [{ email_address, status, last_changed, merge_fields }] }`.
  - `openMailchimp(config, { fetchImpl = fetch, sleep, readFile, writeFile, now }) → { mc, mock: string | null }`: the real client, or the client over the mock when `config.mailchimp.mock` is set. An unreadable or shapeless state file throws `MAILCHIMP_MOCK state file <f> could not be read` / `has no list or members`.

Mock behaviour (the findings, "Mailchimp API behaviour"):
- `GET /lists/{id}` → `{ id, name, stats }`, where `member_count` = subscribed, `unsubscribe_count`, `cleaned_count` are counted from state. A different list id → 404.
- `GET /lists/{id}/members` → pages over non-archived members, with `total_items`.
- `GET /lists/{id}/members/{hash}` → the member (archived included) or 404.
- `PUT .../members/{hash}`: absent → created with `status_if_new` and `last_changed = now()`; archived → 200, unchanged; any other status → merge fields updated, status unchanged.
- `DELETE .../members/{hash}` → status `archived`, 204; absent → 404.
- `persist(state)` is awaited after each write. Any other route → 404 `mock Mailchimp: no route`.

- [ ] **Step 1: Write the failing tests**, driving the mock through the real client (as `test/lgl-vg/lgl-mock.test.js` does): each bullet above as one test; plus `openMailchimp` with a missing file rejects with the message above.
- [ ] **Step 2: Run** `node --test test/vg-mailchimp/mailchimp-mock.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement**, modeled on `src/lgl-vg/lgl-mock.js` (`respond`, `page`, `openLgl`).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "vg-mailchimp: MAILCHIMP_MOCK"`.

---

### Task 4: Read-only VG client

**Files:**
- Create: `src/vg-mailchimp/vg.js`
- Test: `test/vg-mailchimp/vg.test.js`

**Interfaces:**
- Produces: `createVgReader({ apiUrl, oidcUrl, clientId, clientSecret, scope, fetchImpl = fetch, now = Date.now, timeoutMs = 60_000 }) → { whoAmI(opts), privacyStatus(), currentPrivacyRules(), acknowledgePrivacy(rulesId), listPersons() }`.
  - `listPersons()` → `GET /persons?projection=detail`; throws `The service account cannot read donors (donor:read is missing)` when rows exist and none has a `donor` key.
  - `acknowledgePrivacy` → `POST /privacy/acknowledgements`; the only non-GET.
  - Errors as `src/lgl-vg/vg.js`: `status`, `final` on a refused sign-in.

- [ ] **Step 1: Write the failing tests**: token fetch and reuse until expiry; 401 retried once with a fresh token; refused sign-in (`invalid_client`) → `final: true`; 403 message carries the role/acknowledgement hint; `listPersons` donor-key check; a test that records every method sent through `fetchImpl` across `whoAmI`, `privacyStatus`, `listPersons` and finds only `POST` to the token URL and `GET` elsewhere.
- [ ] **Step 2: Run** `node --test test/vg-mailchimp/vg.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** by copying the sign-in, `timedFetch` and `request` from `src/lgl-vg/vg.js`, keeping only the five methods.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "vg-mailchimp: read-only VG client"`.

---

### Task 5: Cohort

**Files:**
- Create: `src/vg-mailchimp/cohort.js`
- Test: `test/vg-mailchimp/cohort.test.js`

**Interfaces:**
- Consumes: `subscriberHash` (Task 2).
- Produces:
  - `inCohort(person) → boolean`: `!person.deceased && (person.memberStatus === 'Active' || person.volunteerStatus === 'Active' || person.donor != null)`.
  - `isValidEmail(email) → boolean`: one `@`, non-empty local part, domain containing a dot not at either end, no whitespace.
  - `buildCandidates(persons) → { cohortSize, candidates: Candidate[], leftOut: Record[] }` where
    `Candidate = { email, hash, personIds: string[], firstName, lastName }` (personIds sorted numerically; names from `detail` of the lowest id) and
    `Record = { kind: 'left-out', reason: 'no-email' | 'invalid-email', personIds, email }`. Candidates are sorted by their lowest person id.

- [ ] **Step 1: Write the failing tests**:
  - Active member, Active volunteer, donor-only → in; `memberStatus: 'Dropped'` alone → out (Review Focus 4); `deceased: true` with Active member → out; `memberStatus: null, volunteerStatus: null, donor: null` → out.
  - `' Jane@Example.org '` (personId `12`, firstName Jane) and `'jane@example.org'` (personId `7`, firstName John) → one candidate, `email: 'jane@example.org'`, `personIds: ['7', '12']`, `firstName: 'John'` (Review Focus 3).
  - Email `null` or `''` → `no-email`; `'jane.example.org'`, `'jane@example'`, `'ja ne@example.org'` → `invalid-email`, not a candidate.
  - `cohortSize` counts in-cohort persons, including those left out.
- [ ] **Step 2: Run** `node --test test/vg-mailchimp/cohort.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Person fields per spec "Constraints": `personId`, `deceased`, `email`, `memberStatus`, `volunteerStatus`, `donor`, `detail.firstName`, `detail.lastName`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "vg-mailchimp: cohort"`.

---

### Task 6: Decisions (pure)

**Files:**
- Create: `src/vg-mailchimp/decide.js`
- Test: `test/vg-mailchimp/decide.test.js`

**Interfaces:**
- Produces:
  - `selectArchives(members, nowMs, afterDays) → member[]`: status `unsubscribed` and `Date.parse(last_changed) <= nowMs - afterDays * 86_400_000`.
  - `classify(candidate, status: string | null) → { action: 'add' | 'present' | 'skip', reason }`: `null` → add; `'subscribed'` → present; anything else → skip with `reason = status` (fail-closed, from `mailchimp-poc/sync/classify.mjs`).
  - `billable(stats) → number`: `member_count + unsubscribe_count`.
  - `limitAdds(adds, { billable, planLimit, limitMargin }) → { add, held }`: room = `max(0, planLimit − limitMargin − billable)`; first `room` in order go to `add`, rest to `held`.
  - `capExceeded(count, max) → boolean`: `max !== null && count > max`.
  - `summaryLine(s) → string`, exact form:
    `MAILCHIMP OK adds=<n> archives=<n> subscribed=<n> left-out=<n> (no-email=<n> invalid-email=<n> unsubscribed=<n> cleaned=<n> archived=<n> limit=<n> cap=<n> other=<n>) billable=<n>/<limit> writes=add:<on|off>,archive:<on|off>`
    for `s = { adds, archives, subscribed, leftOut: { [reason]: n }, billable, planLimit, writeAdd, writeArchive }`, where `other` sums reasons not named.

- [ ] **Step 1: Write the failing tests**: archive age boundary (exactly 30 days → selected; 29 days 23 h → not); `pending`, `transactional`, `cleaned`, `archived`, `'weird'` all skip; `limitAdds` with billable 4890, limit 5000, margin 100 and 15 adds → 10 add, 5 held; billable already over → 0 add; `capExceeded(51, 50)` true, `(50, 50)` false, `(999, null)` false; `summaryLine` exact string for a fixed input including `other=2` from `pending: 1, write-unconfirmed: 1`.
- [ ] **Step 2: Run** `node --test test/vg-mailchimp/decide.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "vg-mailchimp: decisions"`.

---

### Task 7: One run

**Files:**
- Create: `src/vg-mailchimp/run.js`
- Test: `test/vg-mailchimp/run.test.js`

**Interfaces:**
- Consumes: Tasks 2–6.
- Produces: `runOnce({ config, vg, mc, now, sleep, writeFile, stdout, signal, writeAdd, writeArchive, maxAdd, maxArchive }) → { outcome: 'ok' | 'failed' | 'stopped', retryable: boolean, runId }`. `maxAdd`/`maxArchive` are numbers or `null` (no cap; by-hand override). `writeFile(path, text, { append })` as `src/lgl-vg/main.js`.

Behaviour is the spec's "A run", steps 1–7, in order. Pinned details:
- `runId = new Date(now()).toISOString().replace(/[:.]/g, '-')`; records go to `${outDir}/mailchimp-${runId}.jsonl`, written once at the end of the run (and on failure, with what was recorded so far); snapshot to `${outDir}/audience-${runId}.json` before the first write, only when a write switch is on.
- Record shape: `{ kind, reason?, personIds, email, hash, status?, at }` (spec "Records").
- `cohortSize < config.minCohort` or zero persons → `MAILCHIMP FAILED cohort <n> is below MIN_COHORT <m>`, `retryable: false`, no writes.
- Billable is re-read (`mc.getList()`) after archiving and before the guard.
- Cap tripped: print `MAILCHIMP CAP archive=<n> max=<m>` or `MAILCHIMP CAP add=<n> max=<m>`, write none of that kind; the adds are recorded `left-out` / `cap`. The run still ends `ok`.
- Guard held some: print `MAILCHIMP LIMIT billable=<n> limit=<l> margin=<m> held=<k>`; held are `left-out` / `limit`.
- `signal.aborted` is checked before each write; aborted with `'shutdown'` → `stopped`, with `'timeout'` → `MAILCHIMP FAILED run timed out`, retryable.
- Any thrown error → `MAILCHIMP FAILED <message>`; `retryable = !err.final`.
- Success prints `summaryLine(...)` only.

- [ ] **Step 1: Write the failing tests** against the Task 3 mock and a fake `vg.listPersons()` (invented persons; set `minCohort` low in the test config):
  - Dry run: no write requests reach the mock, no snapshot file, records file has `left-out` lines, summary has `adds=` the would-add count and `writes=add:off,archive:off`.
  - Add: absent candidate → mock member `subscribed` with `FNAME`/`LNAME`; record `added`.
  - Archived candidate (present in mock as archived, absent from the list pass) → looked up by hash, recorded `left-out` / `archived`, no PUT.
  - **Review Focus 1**: a mock where PUT on an absent address returns 200 but leaves the contact `archived` (inject via a wrapped fetch) → `left-out` / `write-unconfirmed`, `adds=0`.
  - Archive: unsubscribed 31 days ago → `archived` in mock, record `archived`; 10 days ago → untouched.
  - **Review Focus 2**: wrapped fetch flips the contact to `subscribed` on the pre-archive GET → no DELETE, record `archive-skipped` with `status: 'subscribed'`.
  - Archive cap: 3 eligible, `maxArchive: 2` → none archived, `MAILCHIMP CAP archive=3 max=2`; `maxArchive: null` → all 3 archived.
  - Billing guard: stats leave room for 1, 3 to add → 1 added, 2 `limit`, `MAILCHIMP LIMIT` line; archiving first frees room (archive 2 then 3 fit).
  - `MIN_COHORT`: cohort below → `failed`, `retryable: false`, no Mailchimp requests after `getList`.
  - Snapshot written before the first DELETE/PUT (assert order of `writeFile` vs fetch calls).
  - Abort with `'shutdown'` between two adds → `stopped`, the first is recorded.
  - 300 ms `sleep` between writes.
- [ ] **Step 2: Run** `node --test test/vg-mailchimp/run.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `runOnce`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "vg-mailchimp: one run (add, archive, records)"`.

---

### Task 8: Scheduler and service

**Files:**
- Create: `src/vg-mailchimp/scheduler.js`, `src/vg-mailchimp/service.js`
- Test: `test/vg-mailchimp/scheduler.test.js`, `test/vg-mailchimp/service.test.js`

**Interfaces:**
- Consumes: `runOnce` (Task 7), `createVgReader` (Task 4), the `mc` client (Task 2/3).
- Produces:
  - `nextNightly(nowMs, hhmm) → ms` (copy from `src/lgl-vg/scheduler.js`).
  - `createScheduler({ now, setTimer, clearTimer, runUtc, runJob, stdout, heartbeatMs = 300_000, retryDelayMs = 3_600_000, maxRetries = 3 }) → { start(), stop() }`. `runJob() → { outcome, retryable }`. `start()` runs a job at once, then nightly. Heartbeat: `MAILCHIMP ALIVE last=<ISO|none> result=<ok|failed|running|none> next=<ISO>`.
  - `pruneRecords({ dir, keepDays, now, readdir, stat, unlink }) → number`: deletes `mailchimp-*.jsonl` and `audience-*.json` older than `keepDays`.
  - `startService({ config, vg, mc, stdout, now, setTimer, clearTimer, sleep, writeFile, fs }) → { stop() } | null`.

Start-up (budget and tries as `src/lgl-vg/service.js` `withTries`): `vg.whoAmI` → `STARTUP VG signed in as <username>`; `mc.getList()` → refuse unless `name === config.mailchimp.listName`, else `STARTUP Mailchimp audience <name> reached`; then `STARTUP scheduler started write-add=<on|off> write-archive=<on|off> nightly=<HH:MM>Z`. Any failure → `STARTUP FAILED <message>`, returns `null`. Each job gets an AbortController with the `RUN_TIMEOUT_MINUTES` ceiling, calls `runOnce` with `maxAdd: config.maxAdd, maxArchive: config.maxArchive`, then `pruneRecords`.

- [ ] **Step 1: Write the failing tests** with injected clock and timers (pattern: `test/lgl-vg/scheduler.test.js`, `test/lgl-vg/service.test.js`): run at start then at the next `08:00Z`; a retryable failure retries after one hour, at most 3 times, then waits for the night; a non-retryable failure does not retry; heartbeat prints every 5 min while a job runs with `result=running`; `stop()` aborts the running job with `'shutdown'` and schedules nothing; audience-name mismatch → `STARTUP FAILED` naming both names; `pruneRecords` deletes only matching old files.
- [ ] **Step 2: Run** `node --test test/vg-mailchimp/scheduler.test.js test/vg-mailchimp/service.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement**, copying and cutting down `src/lgl-vg/scheduler.js` (no ticks, no checks) and `src/lgl-vg/service.js`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "vg-mailchimp: scheduler and service"`.

---

### Task 9: Command line, wiring, docs

**Files:**
- Create: `src/vg-mailchimp/main.js`, `test/vg-mailchimp/main.test.js`, `docs/vg-mailchimp.1.md`
- Modify: `package.json` (scripts), `deploy/docker-compose.example.yml`, `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: `run(argv, deps) → exit code`, `envFileFrom(argv)`, `stamped(write, now)` (copied from `src/lgl-vg/main.js`).

Usage:
```
node src/vg-mailchimp/main.js
node src/vg-mailchimp/main.js --once [--write-add] [--write-archive] [--max-add <n>] [--max-archive <n>] [--out <dir>]
node src/vg-mailchimp/main.js setup [--acknowledge-privacy]
Any command also takes --env <file> (default .env).
```
- `--once` ignores the `WRITE_*` switches: it writes only with its own flags. `--max-*` override `MAX_ADD`/`MAX_ARCHIVE`. Exit 0 on `ok`, 1 otherwise.
- `setup` follows `src/lgl-vg/main.js` `setup`; on a 403 from `listPersons` it prints `<username> has no role grant. Grant it the Mailchimp Sync role at federation level in VG, then run setup again.`
- `package.json` scripts: `"mailchimp": "node src/vg-mailchimp/main.js"`, `"mailchimp-once": "node src/vg-mailchimp/main.js --once"`, `"mailchimp-setup": "node src/vg-mailchimp/main.js setup"`.
- Compose example: a `mailchimp` service beside `sync`, same image line form, `command: ["node", "src/vg-mailchimp/main.js"]`, volumes `./vg-mailchimp/.env:/app/.env:ro` and `./vg-mailchimp/out:/app/out`.
- `docs/vg-mailchimp.1.md` in the form of `docs/vg-sync.1.md`: commands, every setting with its default, log lines, records format.
- `README.md`: a short section naming the second executable and pointing to the man page.

- [ ] **Step 1: Write the failing tests**: unknown command → usage, exit 2; `--once` with mocks and no flags makes no writes even with `WRITE_MAILCHIMP_ADD=true` in env; `--once --write-add --max-add 1` with two to add → none added, `MAILCHIMP CAP add=2 max=1` printed; `--max-add 2` → both added; `setup` 403 message; service mode prints the three `STARTUP` lines then stops on the injected `SIGTERM` with `STOPPING`, `STOPPED`.
- [ ] **Step 2: Run** `node --test test/vg-mailchimp/main.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** and update the wiring files.
- [ ] **Step 4: Run** `npm test`. Expected: all tests pass, `test/lgl-vg/` included.
- [ ] **Step 5: Check** `grep -rn "lgl-vg/" src/vg-mailchimp/` and `grep -rn "delete-permanent" src/vg-mailchimp/` print nothing (comments included). (No `tags` key is pinned by the Task 2 body test.)
- [ ] **Step 6: Commit** `git commit -m "vg-mailchimp: command line, compose example, man page"`.

---

### Task 10: The VG role (repo `~/dev/village-green`)

Another repo with its own conventions: read its `CLAUDE.md` first, work on a branch, and follow its board rules (ask the engineer which board item this goes under).

**Files:**
- Create: `api/source/service/migrations/0036-mailchimp-sync-role.js`, modeled on `0033-sync.js` (role and permission inserts only, no tables), with `down`.
- Modify: whatever the repo's conventions require alongside a migration (for example `sql/current/20-vg-static.sql`, role tests, docs listing roles).

- Role 9, `Mailchimp Sync`, scope `federation`, description `The Mailchimp sync service account: reads persons and donors`, `isSystem` 1.
- Permissions: `person:read`, `member:read`, `volunteer:read`, `donor:read`. (`member:read` and `volunteer:read` are needed because a person is hidden from a caller who cannot read any of their associations; see `0033-sync.js`.) Not `member:read_inactive` or `volunteer:read_inactive`.

- [ ] **Step 1:** Write the app's test for the role (pattern: however `0033`'s role is tested): role 9 exists with exactly those four permissions; a caller with only role 9 gets `GET /persons?projection=detail` rows with `memberStatus`, `volunteerStatus`, `donor`, `detail.firstName`; and is refused `PATCH /persons/{id}`.
- [ ] **Step 2:** Run it; expected FAIL.
- [ ] **Step 3:** Write the migration.
- [ ] **Step 4:** Run the app's test suite; expected PASS.
- [ ] **Step 5:** Commit on the branch. Merging and releasing are the engineer's.

---

### Task 11: Deploy and monitoring (repo `~/dev/tvcri/vg-utils`)

**Files:**
- Modify: `vm-sidecar-deploy/sidecar-deploy.py` (service table), its tests and `README.md`; `vm-logship` `CONTAINERS`; add `vm-sidecar-deploy/alerts-mailchimp.sh` modeled on `alerts-sync.sh`.

- Deployer row: service `mailchimp`, repository `carlsmig/vg-sync`, markers = the three `STARTUP` lines of Task 8, failure pattern `STARTUP FAILED|MAILCHIMP FAILED`, pin not required.
- [ ] **Step 1:** Add a deployer test: a compose file with `sync` and `mailchimp` both pinned to `carlsmig/vg-sync@sha256:<old>`; a new digest rewrites both pin lines and gates each service on its own markers. Run; expected FAIL if two services on one repository are not handled, else PASS (keep the test either way).
- [ ] **Step 2:** Make it pass. Add the row and `tvcri-mailchimp-1` to logship `CONTAINERS`.
- [ ] **Step 3:** Write `alerts-mailchimp.sh` creating, disabled: `vg-mailchimp-failed` (`VmContainerLogs_CL | where Container == 'tvcri-mailchimp-1' | where Message has_cs 'MAILCHIMP FAILED' or Message has_cs 'STARTUP FAILED' or Message has_cs 'MAILCHIMP LIMIT' or Message has_cs 'MAILCHIMP CAP'`, every 5 min, window 15, count > 0) and `vg-mailchimp-silent` (`... has_cs 'MAILCHIMP ALIVE'`, every 5, window 15, count < 1), plus `enable`/`disable`. **Do not run it**: creating alerts needs the engineer's go-ahead.
- [ ] **Step 4:** Run the vg-utils tests; expected PASS. Commit.

---

### Task 12: Rehearsal (workstation, no production writes)

- [ ] **Step 1: Mock write rehearsal.** Local dev VG (harness data), a `MAILCHIMP_MOCK` state file of invented contacts in all statuses, `MIN_COHORT` set low: `node src/vg-mailchimp/main.js --once --write-add --write-archive --env <rehearsal env>`. Expected: `MAILCHIMP OK` with adds and archives matching the state file; the records file has one line per non-subscribed outcome. Run again: `adds=0 archives=0`.
- [ ] **Step 2: Service rehearsal.** Build the image, run the `mailchimp` compose service against the same env with `network_mode: host`. Expected: three `STARTUP` lines, a `MAILCHIMP OK`, `MAILCHIMP ALIVE` every 5 minutes, `STOPPING`/`STOPPED` on `docker compose stop`.
- [ ] **Step 3: Ask the engineer** for the go-ahead for two production Mailchimp reads (CLAUDE.md), then: (a) the `last_changed` check, a read of unsubscribed contacts with their member activity, confirming `last_changed` tracks the unsubscribe (spec step 4); if it does not, stop and bring it back. (b) the real-data dry run, a production VG snapshot restored locally (`vg-utils/mysql-dump`) and the dry run against the production audience, compared with the hand-run `sync-vg-to-mailchimp.mjs` dry run on the same snapshot. Report counts only, names masked.
- [ ] **Step 4:** Write `docs/handoff-<date>-mailchimp-go-live.md` with the go-live steps from the spec, the observed counts and anything that differed. Commit.

Go-live itself (deploy, the by-hand first archive and add, switching writes on, enabling alerts) is the engineer's, per the spec.
