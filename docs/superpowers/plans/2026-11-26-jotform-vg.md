# JotForm → VG: the sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third executable, `src/jotform-vg/`, that brings Friendly Calls & Visits reports from JotForm into VG every 5 minutes, matches names by rules, holds what it cannot settle, and removes deleted reports nightly.

**Architecture:** A long-lived service, like `src/vg-mailchimp/`, that shares no code with the other two. Pure modules (parse, names, match, decide, holds) are fed by two thin clients (JotForm, VG API). `pass.js` runs a change pass (cursor) or a full pass (everything, with deletions), and a scheduler runs change passes every few minutes and a full pass nightly. Writes are off unless `WRITE_VG=true`.

**Tech Stack:** Node 24, no dependencies, built-in `fetch`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-26-jotform-vg-design.md`. The VG side is a separate plan, `~/dev/village-green/scratch/superpowers/plans/2026-11-26-jotform-vg-app.md`; its Task 3 table defines the endpoints used here. Branch: `jotform-vg` (holds the spec). Board card VG-202611-528.

## Global Constraints

- **Public repo:** invented people and ids only in code, tests, fixtures, docs and commit messages. No form id, API key or real name. Ported comments are checked for real data before commit.
- **Shares no code** with `src/lgl-vg/` or `src/vg-mailchimp/`. Copy helpers; never import across.
- **Dry run by default:** nothing is written to VG unless `WRITE_VG=true`. In a dry run the pass computes everything and logs what it would write (counts).
- **Never writes to JotForm.** The JotForm client has only GET.
- **Log lines carry counts only**, no names, emails or notes. Markers: `JOTFORM ALIVE` (heartbeat, every 5 min), `JOTFORM OK <change|full> …counts`, `JOTFORM FAILED <reason>`. **Plan call:** the spec's `SYNC ALIVE` / `PASS FAILED` are lgl-vg's markers; this service gets its own prefix, as `vg-mailchimp` did, so alerts can tell them apart.
- JotForm times (`created_at`, `updated_at`) are America/New_York wall-clock strings `YYYY-MM-DD HH:MM:SS`. They are compared and stored as given, never converted.
- Settings (env), with defaults: `JOTFORM_API_KEY` (required unless `JOTFORM_MOCK`), `JOTFORM_FORM_ID` (required), `JOTFORM_MOCK` (path to a mock state file), `VG_API_URL`, `VG_OIDC_URL`, `VG_CLIENT_ID`, `VG_CLIENT_SECRET` (required), `VG_SCOPE` (`vg`), `WRITE_VG` (`false`), `CHANGE_EVERY_MINUTES` (5), `FULL_RUN_UTC` (`08:00`, which is 03:00 Eastern in winter), `OVERLAP_MINUTES` (120), `MIN_FULL_PERCENT` (90), `DATE_AHEAD_DAYS` (1), `DATE_BEHIND_DAYS` (90), `RUN_TIMEOUT_MINUTES` (30), `IMAGE_REVISION`.

## Review Focus

1. **The same submission arriving twice in one change pass** (it is both newly created and edited inside the window). Expect one PUT, not two. Test in Task 8.
2. **A JotForm full read that comes back short or empty** (an API hiccup, a wrong form id). Expect no deletions and `JOTFORM FAILED`. Test in Task 8.
3. **A name with accents, apostrophes, hyphens or extra spaces** ("Zoë  O'Brien-Smith"). Expect it to normalize to the same key as the VG name without them. Test in Task 4.
4. **A household email shared by two people.** Expect the email step to defer to the name steps, never to pick one at random. Test in Task 5.
5. **A report from someone dropped since** (an inactive member or volunteer). Expect it still to match. Test in Task 5.

---

### Task 1: Configuration

**Files:**
- Create: `src/jotform-vg/config.js`
- Test: `test/jotform-vg/config.test.js`

**Interfaces:**
- Produces: `loadConfig(env = process.env) → { jotform: { apiKey, formId, mock }, vg: { apiUrl, oidcUrl, clientId, clientSecret, scope }, writeVg, changeEveryMinutes, fullRunUtc, overlapMinutes, minFullPercent, dateAheadDays, dateBehindDays, runTimeoutMinutes, imageRevision }`.

- [ ] **Step 1: Write failing tests.**
  - Defaults: given only the required variables, `writeVg === false`, `changeEveryMinutes === 5`, `fullRunUtc === '08:00'`, `overlapMinutes === 120`, `minFullPercent === 90`, `dateAheadDays === 1`, `dateBehindDays === 90`.
  - Missing `JOTFORM_FORM_ID` throws `Missing environment variables: JOTFORM_FORM_ID`.
  - `JOTFORM_MOCK` set means `JOTFORM_API_KEY` is not required.
  - `WRITE_VG=true` → `writeVg === true`; any other value → `false`.
  - `MIN_FULL_PERCENT=101` throws; `CHANGE_EVERY_MINUTES=0` throws.
- [ ] **Step 2: Run** `node --test test/jotform-vg/config.test.js`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** by copying `src/vg-mailchimp/config.js`'s helpers (`present`, `toUrl`, `toCount`, `toPositive`, `toBounded`, `toClock`).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "jotform-vg: configuration"`

### Task 2: JotForm client and mock

**Files:**
- Create: `src/jotform-vg/jotform.js`, `src/jotform-vg/jotform-mock.js`
- Test: `test/jotform-vg/jotform.test.js`, `test/jotform-vg/jotform-mock.test.js`

**Interfaces:**
- Produces:
  - `createJotformReader({ apiKey, formId, fetchImpl = fetch, timeoutMs = 60_000 }) → { listSince(field: 'created_at' | 'updated_at', after: string) → Promise<Submission[]>, listAll() → Promise<Submission[]> }`. Both page with `limit=1000`, `orderby=id`, `offset` until a page shorter than 1000. The key goes in the `APIKEY` header. A non-2xx response throws an `Error` with `.status`; 401 and 403 set `.final = true`. A body whose `responseCode` is not 200 throws too.
  - `Submission` is JotForm's object as received: `{ id, created_at, updated_at, status, answers: { [qid]: { answer } } }`.
  - `createMockJotformFetch({ state, persist }) → fetchImpl`: serves `GET /form/{id}/submissions` from `state.submissions`, honoring `filter` (`created_at:gt`, `updated_at:gt`, string comparison), `limit` and `offset`. Anything else → 404. `openJotform(config, deps) → reader` returns the real reader or, with `config.jotform.mock`, one over the mock (as `openMailchimp` does).

- [ ] **Step 1: Write failing tests** with an injected `fetchImpl` recording URLs:
  - `listSince('updated_at', '2026-11-01 00:00:00')` sends `filter={"updated_at:gt":"2026-11-01 00:00:00"}` and `APIKEY`.
  - Paging: 1000 then 3 submissions → two requests (`offset=0`, `offset=1000`), 1003 results.
  - 403 → rejects with `final === true`.
  - Mock: 3 invented submissions, `listSince('created_at', <the second's time>)` returns only the third; `listAll` returns 3.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "jotform-vg: JotForm reader and mock"`

### Task 3: Reading a submission

**Files:**
- Create: `src/jotform-vg/parse.js`
- Test: `test/jotform-vg/parse.test.js`, fixture `test/jotform-vg/fixtures/submissions.js` (invented)

**Interfaces:**
- Produces: `parseSubmission(sub, villagesByName: Map<string, string>) → Parsed`, where `Parsed` is:

```js
{
  id, submittedAt /* created_at */, jotformUpdatedAt /* updated_at or null */,
  villageId /* string or null */, villageName /* as typed */,
  volunteer: { first, last, raw /* "First Last" */ }, member: { first, last, raw },
  volunteerEmail /* or null */, visitDate /* 'YYYY-MM-DD' or null */,
  timeSpentMinutes, contactType, activityTypes /* string[] */, activityOther,
  notes, reportingTag /* 'YYYY-MM-DD' or null */,
  unreadable /* null, or a short reason: 'village', 'visit-date', 'time-spent', 'contact-type' */,
}
```

  Question ids: 2 volunteer name, 3 member name, 4 visit date (`answer.datetime`, first 10 chars), 5 minutes, 6 contact type, 8 notes, 10 village, 13 reporting tag (`answer.datetime` or `answer` date), 21 activity types, 23 email. Port `ACTIVITY_TYPE_MAP`, `mapActivityTypes` and `extractActivityOther` from the prototype (`ce-sheets-sync`, branch `jot-sync`, `lib/fcv-sync.js`) exactly, including the non-breaking spaces in the Outing option. Do **not** port `VILLAGE_NAME_MAP`. Village lookup is exact on VG's village name.

- [ ] **Step 1: Write failing tests** over invented fixtures:
  - A complete submission parses every field; `volunteer.raw === 'Jane Doe'`.
  - Activity answer in dict form `{ 0: 'Pet visit', other: 'Baking' }` → `activityTypes` `['pet', 'other']`, `activityOther` `'Baking'`.
  - `village` `'Atlantis'` (unknown) → `unreadable === 'village'`, `villageId === null`.
  - Minutes `'45 min'` → `unreadable === 'time-spent'`; `'0'` is fine.
  - No email answer → `volunteerEmail === null`.
  - A reporting tag that is not a date (`'sometime'`) → `reportingTag === null` (VG's PUT rejects anything but `YYYY-MM-DD` or null, which would fail the whole pass).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "jotform-vg: read a submission"`

### Task 4: Name keys and the name test

**Files:**
- Create: `src/jotform-vg/names.js`, `src/jotform-vg/nicknames.js`
- Test: `test/jotform-vg/names.test.js`

**Interfaces:**
- Produces:
  - `nameKey(s) → string`: NFKD, strip combining marks, lowercase, every run of non-letters → one space, trim. `nameKey("  Zoë  O'Brien-Smith ") === 'zoe o brien smith'`.
  - `NICKNAMES`: an array of groups of keys, e.g. `['william', 'bill', 'will', 'billy', 'liam']`, `['elizabeth', 'liz', 'beth', 'betsy', 'betty', 'lizzie']`, `['deborah', 'debra', 'deb', 'debbie']`. A few dozen common English groups.
  - `firstNamesAgree(typedFirstKey, person) → boolean`: equal to the person's first-name key or nickname key, or the two share a `NICKNAMES` group.
  - `nameMatches(typed: { first, last }, person: { firstName, lastName, nickname }) → boolean`: last keys equal and `firstNamesAgree`, or the same with typed first and last swapped. A typed last part of several words matches when its key equals the person's last-name key (so "O'Brien-Smith" and "OBrien Smith" differ, and that is acceptable).

- [ ] **Step 1: Write failing tests** (Review Focus 3): the `nameKey` example above; `nameMatches({ first: 'Bill', last: 'Doe' }, { firstName: 'William', lastName: 'Doe' })` is true; swapped `{ first: 'Doe', last: 'Jane' }` matches Jane Doe; `{ first: 'Jane', last: 'Roe' }` does not match Jane Doe; a nickname stored in VG (`nickname: 'Sunny'`) matches `{ first: 'Sunny', last: 'Doe' }`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "jotform-vg: name keys, nicknames and the name test"`

### Task 5: Matching a person

**Files:**
- Create: `src/jotform-vg/match.js`
- Test: `test/jotform-vg/match.test.js`

**Interfaces:**
- Consumes: Task 4.
- Produces:
  - `buildRoster(persons) → Roster`, from VG `GET /persons?projection=detail` rows: each `{ personId, firstName, lastName, nickname, email /* lowercased or null */, villageId /* string or null */, isMember: memberStatus != null, isVolunteer: volunteerStatus != null }`. Check the real response shape on the dev API before writing this (names are under `detail`, village under `village.villageId`).
  - `rememberedKey(role, nameKey, villageId) → string`, `buildRemembered(nameMatches) → Map<string, { personId, ignore }>`.
  - `matchPerson({ role: 'volunteer' | 'member', typed: { first, last, raw }, email, villageId }, roster, remembered) → { personId, how } | { ignore: true } | { personId: null, candidates: string[] }`. `how` ∈ `'remembered' | 'email' | 'name-village' | 'name-elsewhere'`. Rules, in order, as the spec's "Matching" section:
    1. Remembered (role, `nameKey(raw)`, villageId or 0).
    2. Email (volunteer only): roster people with that email **and** `nameMatches`; exactly one → match; otherwise go on.
    3. Role holders in the form's village who `nameMatches`: 1 → `name-village`; 2 or more → held with them as candidates.
    4. Role holders anywhere who `nameMatches`: 1 → `name-elsewhere`; 2 or more → held with candidates; 0 → held with `candidates: []`.

- [ ] **Step 1: Write failing tests** over an invented roster:
  - Remembered beats everything; remembered `ignore` returns `{ ignore: true }`.
  - Email unique and name agrees → `how: 'email'`, even with the form's village wrong.
  - Shared email (two people), typed name fits one → that one via `name-village` (Review Focus 4).
  - Email of a spouse (name disagrees) → not matched by email; falls to names.
  - Two Jane Does in the form's village → `candidates` both, no `personId`.
  - One Jane Doe elsewhere only → `name-elsewhere`.
  - A Dropped member (`memberStatus: 'Dropped'`) still matches (Review Focus 5).
  - A person who is only a volunteer is not a candidate for `role: 'member'`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "jotform-vg: match a typed name to a VG person"`

### Task 6: Deciding a report and its holds

**Files:**
- Create: `src/jotform-vg/decide.js`
- Test: `test/jotform-vg/decide.test.js`

**Interfaces:**
- Consumes: Task 3 `Parsed`, Task 5 `matchPerson` results.
- Produces:
  - `questionableDate(visitDate, submittedAt, { aheadDays, behindDays }) → boolean`: civil-date difference (`Date.UTC` on the `YYYY-MM-DD` parts) of visit minus submission date; true when `> aheadDays` or `< -behindDays`.
  - `decideRow(parsed, volunteerMatch, memberMatch, dateDecision, settings) → Row`, where `Row` is the body for `PUT /friends/sync/submissions/{id}` (app plan Task 3): ids as strings; `volunteerMatch` / `memberMatch` the `how` or null; `held` from the first that applies: `'unreadable'`; `'ignored'` (either match is `{ ignore: true }`, or `dateDecision === 'ignore'`); `'name'`; `'date'` (questionable and `dateDecision` null); else null.
  - `rowFromStored(stored) → Parsed`: rebuilds a `Parsed` from a `GET /friends/sync/submissions` row (for re-matching without JotForm).
  - `collectHolds(decided: Array<{ parsed, row, volunteerResult, memberResult }>) → Hold[]`: one `name` hold per (role, nameKey, villageId) over unmatched results, with `detail: { candidates (union), reportCount, firstVisit, lastVisit, email }` (email: the first non-null on those reports, volunteer holds only); one `date` hold per report held for `'date'`, `detail: { visitDate, submittedAt, rule: 'ahead' | 'behind' }`; one `unreadable` hold per unreadable report, `detail: { reason }`.
  - `rowsDiffer(a, b) → boolean`: compares the writable columns, so unchanged rows are not re-sent.

- [ ] **Step 1: Write failing tests:**
  - `questionableDate('2026-11-21', '2026-11-20 09:00:00', …)` false with `aheadDays: 1`; `'2026-11-22'` true; `'2026-08-21'` with `behindDays: 90` is true (91 days); `'2026-08-22'` false.
  - `held` precedence: unreadable beats ignored beats name beats date.
  - `dateDecision: 'accept'` on a questionable date → `held` null; `'ignore'` → `'ignored'`.
  - Three reports from "Jon Doe" in one village, all unmatched → one name hold, `reportCount: 3`, first and last visit right.
  - `rowFromStored(decideRow(parsed, …))` round-trips the fields matching uses.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "jotform-vg: decide a report and collect holds"`

### Task 7: VG client

**Files:**
- Create: `src/jotform-vg/vg.js`
- Test: `test/jotform-vg/vg.test.js`

**Interfaces:**
- Produces `createVgClient({ apiUrl, oidcUrl, clientId, clientSecret, scope, fetchImpl, now, timeoutMs }) → { whoAmI, listPersons, listVillages, getState, listSubmissions, putSubmission(id, row), deleteSubmission(id), listNameMatches, putHolds(holds) }`. Copy `src/vg-mailchimp/vg.js`'s token handling, timeouts, 401 retry and 403 hint (drop its donor check and privacy calls unless start-up needs them; check `vg-mailchimp/service.js` start-up). `listPersons` is `GET /persons?projection=detail`. `listVillages` is `GET /villages`. The rest are app plan Task 3's endpoints.

- [ ] **Step 1: Write failing tests** with an injected fetch: each method's method, path and body; a 401 refreshes the token once; a 403 error carries the hint.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "jotform-vg: VG API client"`

### Task 8: Passes

**Files:**
- Create: `src/jotform-vg/pass.js`
- Test: `test/jotform-vg/pass.test.js`

**Interfaces:**
- Consumes: Tasks 2 to 7.
- Produces `runPass(kind: 'change' | 'full', { jotform, vg, config, stdout }) → Promise<Counts>`, `Counts = { fetched, inserted, updated, unchanged, deleted, held: { name, date, ignored, unreadable }, openHolds, wrote: boolean }`. It prints one `JOTFORM OK <kind> fetched=… inserted=… …` line and returns. It throws on a failure, and the caller prints `JOTFORM FAILED`.
  1. Read in parallel: persons, villages, name matches, stored submissions (`listSubmissions`). Build the roster, the remembered map and a map of stored rows by id.
  2. **Change:** `getState().cursor`; if null, behave as **full**. Otherwise `after = cursor − overlapMinutes` (civil arithmetic on the string, as UTC). `listSince('created_at', after)` and `listSince('updated_at', after)`, merged by id (Review Focus 1). **Full:** `listAll()`.
  3. For each fetched submission: parse, match, decide (with the stored row's `dateDecision`); collect a PUT if there is no stored row or `rowsDiffer`.
  4. **Re-match stored rows not fetched this pass** (spec, "Re-matching from stored rows"): every held row, and every row whose volunteer or member name now has a remembered answer. A row matched by email or name keeps its person. Collect a PUT if it differs.
  5. **Full only, deletions:** stored ids absent from JotForm. If `fetched < minFullPercent / 100 × storedCount`, throw `Error('full read returned <fetched> of <stored> stored; nothing deleted')` before any write (Review Focus 2).
  6. Holds: `collectHolds` over every row's current decision (fetched and stored alike), so the set sent is complete.
  7. If `config.writeVg`: PUTs, DELETEs, then `putHolds`. Otherwise write nothing and report the counts with `wrote: false`.

- [ ] **Step 1: Write failing tests** with the JotForm mock and a fake VG (an in-memory object implementing Task 7's methods):
  - First full pass over 3 invented submissions inserts 3.
  - A change pass after one edit (mock `updated_at` set) updates 1; unchanged rows are not re-sent.
  - A submission created and edited inside the window is PUT once (Review Focus 1).
  - A change pass when the stored cursor is null runs as full.
  - A full pass after a mock deletion deletes 1; a full pass whose mock returns 1 of 10 stored throws and deletes nothing (Review Focus 2).
  - A held name, then a remembered answer added to the fake VG: the next change pass (no JotForm changes) releases the report (`held` null) and the hold set no longer has it.
  - `writeVg: false`: the fake VG sees no PUT, DELETE or `putHolds`; counts are still returned.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "jotform-vg: change and full passes"`

### Task 9: Scheduler, service and entry point

**Files:**
- Create: `src/jotform-vg/scheduler.js`, `src/jotform-vg/service.js`, `src/jotform-vg/main.js`
- Modify: `package.json` scripts: `"jotform": "node src/jotform-vg/main.js"`, `"jotform-once": "node src/jotform-vg/main.js --once"`
- Test: `test/jotform-vg/scheduler.test.js`, `test/jotform-vg/service.test.js`, `test/jotform-vg/main.test.js`

**Interfaces:**
- Consumes: Task 8 `runPass`.
- Produces:
  - `createScheduler({ now, setTimer, clearTimer, fullRunUtc, changeEveryMs, runJob(kind), stdout, heartbeatMs = 300_000, retryDelayMs = 3_600_000, maxRetries = 3 }) → { start(), stop() }`. One job at a time. At start: a full pass. Change passes start after the first successful full pass, the next armed `changeEveryMs` after one ends. A full pass nightly at `fullRunUtc` (`nextNightly`, copied). A queued full pass goes before a queued change. A failed full pass retries like `vg-mailchimp`'s. A failed change pass waits for the next tick. `JOTFORM ALIVE last=<iso> result=<ok|failed|none>` every `heartbeatMs`, from its own timer.
  - `startService({ config, deps })`: start-up checks (VG `whoAmI`, one JotForm read of the newest submission) within the deployer's 90-second health gate, as `vg-mailchimp/service.js` does; then the scheduler; per-run abort at `RUN_TIMEOUT_MINUTES`; prints `JOTFORM FAILED <message>` on a failed pass, and exits non-zero on a `final` error (401/403).
  - `main.js`: `--env <file>` (as `envFileFrom`), `--once change|full` runs one pass and exits 0 or 1, no argument runs the service. Prints `JOTFORM MOCK` when a mock is in use and `JOTFORM DRY RUN` at start when `writeVg` is false.

- [ ] **Step 1: Write failing tests** with an injected clock and timers (copy `test/vg-mailchimp/scheduler.test.js`'s harness):
  - Start runs full; after it succeeds, a change runs `changeEveryMs` later; a second change runs `changeEveryMs` after the first ends.
  - At `fullRunUtc` a full is queued; if a change is running, the full runs right after it.
  - Heartbeat lines print every `heartbeatMs` while a job runs.
  - `main.js --once change` with a mock and a fake VG prints one `JOTFORM OK change` line and resolves 0.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all tests** `npm test`. Expected: PASS, including the other two executables' tests.
- [ ] **Step 5: Commit.** `git commit -m "jotform-vg: scheduler, service and entry point"`

### Task 10: Image, workflow, deploy example and docs

**Files:**
- Create: `jotform-vg.Dockerfile` (copy `vg-mailchimp.Dockerfile`, `COPY src/jotform-vg`, `CMD ["node", "src/jotform-vg/main.js"]`), `.github/workflows/publish-jotform-vg.yml` (copy `publish-vg-mailchimp.yml`, repository `carlsmig/vg-sync-jotform`, paths `src/jotform-vg/**`, `jotform-vg.Dockerfile`), `docs/jotform-vg.1.md` (a man page in `vg-mailchimp.1.md`'s shape: synopsis, settings, markers, exit codes)
- Modify: `deploy/docker-compose.example.yml` (a `jotform` service like `mailchimp`, host folder `jotform/`), `README.md` (the third executable), `CLAUDE.md` (status line and that a third executable exists)

- [ ] **Step 1: Build the image locally.** `docker build -f jotform-vg.Dockerfile -t vg-sync-jotform:dev .` Expected: success.
- [ ] **Step 2: Run it once against the mock.** `docker run --rm -v $PWD/<scratch env>:/app/.env:ro vg-sync-jotform:dev node src/jotform-vg/main.js --once full` with `JOTFORM_MOCK` and a dev VG client. Expected: `JOTFORM MOCK`, `JOTFORM DRY RUN`, `JOTFORM OK full`.
- [ ] **Step 3: Check that `.github/workflows/test.yml` runs `test/jotform-vg/`** (it runs `node --test`; confirm the glob reaches the new folder).
- [ ] **Step 4: Commit.** `git commit -m "jotform-vg: image, publish workflow, deploy example, docs"`

### Task 11: Rehearsal and the real-data dry run

Needs the app plan merged to the dev API (its Task 5) and a dev Keycloak client for this service.

- [ ] **Step 1: Dev with the mock, writes on.** Snapshot the dev DB first (CLAUDE.md). `WRITE_VG=true`, `JOTFORM_MOCK` with invented submissions. Run `--once full`, then edit and delete in the mock, run `--once change` and `--once full`. Expected: rows, holds and deletions in the dev DB as Task 8's tests describe.
- [ ] **Step 2: Real form, production snapshot, dry run.** Restore a production snapshot to the dev DB (`vg-utils/mysql-dump`; it is real data now), run the app migration on it, and run `--once full` with the real `JOTFORM_API_KEY` and `JOTFORM_FORM_ID` and `WRITE_VG` unset. Reading the form is read-only; tell the engineer before the run. Record, **counts only**: reports, matched by each rule, held by kind, name holds, deletions that would happen (expect 3). Compare the match rate with the engineer's 90% expectation.
- [ ] **Step 3: Write the handoff** `docs/handoff-2026-11-XX-jotform-go-live.md`: the counts, the go-live steps (merge the app PR, create the prod Keycloak client and grant role 10, compose entry and `.env` on the VM, first start with `WRITE_VG=false`, then `true`, then the Azure heartbeat alert modeled on the mailchimp one), and the customer questions from the spec. Commit, push the branch, open the PR. Production steps need the engineer's go-ahead for each.
