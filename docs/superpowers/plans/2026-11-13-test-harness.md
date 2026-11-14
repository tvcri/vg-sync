# Test Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A runner that seeds invented scenarios into the local dev VG database and the LGL trial account, plays edits and real service passes in lockstep, and reports PASS or FAIL per scenario; with the step 3 scenario set passing.

**Architecture:** `harness/` holds pure modules (scenario loading and dates, expectation checks, lockstep order, guard decisions) with unit tests in `npm test`, and I/O modules (an LGL write client, a VG staff client, dev-database reseed) used by `harness/run.js`. Each pass is the real `src/lgl-vg/main.js full` run as a child process with `--env .env.harness`. Nothing in `src/` imports from `harness/`.

**Tech Stack:** Node 24, ES modules, `node:test`, no new dependencies. MySQL statements go through `docker exec <container> mysql`.

**Spec:** `docs/superpowers/specs/2026-11-13-test-harness-design.md`, with the sync design `docs/superpowers/specs/2026-11-11-lgl-vg-sync-design.md` as the authority on what the sync does.

## Global Constraints

- The repo is public. Invented data only in code, scenarios, tests, docs and commit messages (Jane Doe). No LGL or VG ids from the live systems in committed files.
- Agents run the harness themselves: it touches only the dev VG database (`village-green-orch-db-1`) and the LGL trial account. Never production LGL, the production VG database, Mailchimp, or the demo stack (`village-green-demo-*`).
- The harness refuses to start unless the guards pass (Task 4). Every live command in this plan runs after the guards.
- Nothing in `src/lgl-vg/` learns about the harness, except the general `--env <file>` option (Task 1).
- `src/lgl-vg/lgl.js` stays read-only (GET only).
- Never pipe a long run through `tail`; stream it or `tee` it.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Environment: `.env.harness` (gitignored, already filled except the two fund ids, which Task 2 settles); names in `.env.harness.example`. New variables added by this plan go in both.

## Review Focus

1. **The guards fail closed.** A missing variable, an unreachable sentinel, or a non-local host must stop the run before any write, with the failing check named. Tested in Task 4.
2. **Lockstep isolation.** A scenario with fewer phases must still be checked as undisturbed in later phases (no writes, no new holds for its person). Tested in Task 3.
3. **A dismissed hold that later reopens.** The app's `createSyncHoldDismissal` says a `staff` dismissal "is permanent; a rule dismissal is reconsidered". `holds.js` reopens any dismissed hold whose fingerprint changed. The scenario in Task 8 settles which is true; if they disagree, that is a finding for the engineer, not something to paper over in the scenario.
4. **Comparable-form expectations.** `expect` compares through `comparable()` from `fields.js`, so a scenario cannot pass on formatting alone and cannot fail on it either. Tested in Task 3.
5. **Reseed leaves the service able to run.** After the generator empties `user_data` and `role_grant`, both accounts get their rows, grants and privacy acknowledgement back before the first pass. Checked live in Task 5.

---

### Task 1: `--env <file>` on the service command

**Files:**
- Modify: `src/lgl-vg/main.js` (argument parsing and the entry block at the bottom, which today does `if (existsSync('.env')) process.loadEnvFile('.env')`)
- Test: `test/lgl-vg/main.test.js`

**Interfaces:**
- Produces: `node src/lgl-vg/main.js <command> --env <file> ...`. Default `.env`. A named file that does not exist is an error (exit 1, message names the file); the default `.env` missing stays silent, as today.

- [ ] **Step 1: Write the failing tests** in `test/lgl-vg/main.test.js`: export a pure `envFileFrom(argv)` from `main.js` and test it: `envFileFrom(['full'])` → `{ file: '.env', explicit: false, rest: ['full'] }`; `envFileFrom(['full', '--env', '.env.harness', '--write-vg'])` → `{ file: '.env.harness', explicit: true, rest: ['full', '--write-vg'] }`; `envFileFrom(['full', '--env'])` throws `--env needs a file`.
- [ ] **Step 2: Run** `node --test test/lgl-vg/main.test.js`. Expected: FAIL, `envFileFrom` not exported.
- [ ] **Step 3: Implement** `envFileFrom` and use it in the entry block: strip `--env <file>` before `run()` sees argv, load the file with `process.loadEnvFile(file)`; if `explicit` and the file is missing, print `No such env file: <file>` and exit 1. Variables already in the environment are not overridden (Node's behavior); say so in the usage text.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `"Service command: --env <file> chooses the environment file"`

### Task 2: LGL write client and the trial account's facts

**Files:**
- Create: `harness/lgl-write.js`
- Create: `harness/discover.js` (a one-off command, kept for the next trial account)
- Test: `test/harness/lgl-write.test.js`
- Modify: `docs/superpowers/specs/2026-11-13-test-harness-design.md` ("Left to the builder": record each answer), `.env.harness`, `.env.harness.example`

**Interfaces:**
- Produces `createLglWriter({ apiKey, fetchImpl = fetch, sleep })` returning:
  - `request(method, path, body?)` → parsed JSON (retry on 429 and 5xx exactly as `lgl.js`: `Retry-After` else 30, 60, 120, 240 s, 5 attempts)
  - `createConstituent(body)` → `{ id }`; `updateConstituent(id, body)`; `deleteConstituent(id)`
  - `addEntry(id, kind, body)` → `{ id }`, `updateEntry(id, kind, entryId, body)`, `listEntries(id, kind)` → items; `kind` is `street_addresses | email_addresses | phone_numbers`
  - `addGift(id, body)` → `{ id }`
  - `getConstituent(id)` (with the three entry lists expanded)
  - `listHarnessConstituents()` → the constituents carrying the harness marker
  - `countConstituents()` → number
  - `HARNESS_MARKER` (exported constant)

- [ ] **Step 1: Write failing tests** with a fake `fetch` (the pattern in `test/lgl-vg/lgl.test.js`): a 429 with `Retry-After: 7` sleeps 7000 ms and retries; a 500 four times then 200 succeeds with sleeps 30000, 60000, 120000, 240000; a 404 throws `LGL DELETE /constituents/9 → 404: ...`; `createConstituent` sends the marker field on every create.
- [ ] **Step 2: Run** `node --test test/harness/`. Expected: FAIL.
- [ ] **Step 3: Write `harness/discover.js`** first, run it against the trial account (`node harness/discover.js --env .env.harness`), and settle from its output, recording each answer in the harness design's "Left to the builder" section:
  - **The marker:** which constituent field the API can set and the search can filter on (`external_constituent_id`, a custom field, or a group/category). `HARNESS_MARKER` uses it; value `vg-sync-harness`.
  - **Gifts:** the create call and its required fields (`GET /funds`, `GET /payment_types`, the gift create path).
  - **The stand-in dues fund and payment type:** create them by API if the API allows; otherwise **stop and hand back to the engineer** to create a fund named "Harness Membership" and use the existing PayPal type (or one named "Harness PayPal") in the LGL screen. Put both ids in `.env.harness`.
  - **Deceased:** which constituent fields set deceased and its date.
  - **Merges:** whether the API can merge constituents. If not, record it; merge scenarios wait for step 4.
  Discovery requests stay under 100. It must run the same sentinel check `spike/lgl-trial.mjs` makes before any write.
- [ ] **Step 4: Implement `harness/lgl-write.js`** to the interface, using what Step 3 found.
- [ ] **Step 5: Run** `npm test`. Expected: all pass.
- [ ] **Step 6: Commit** `"Harness: LGL write client and the trial account's facts"`

### Task 3: Scenarios, dates, expectations and lockstep (pure)

**Files:**
- Create: `harness/scenario.js`, `harness/expect.js`
- Test: `test/harness/scenario.test.js`, `test/harness/expect.test.js`

**Interfaces:**
- Consumes: `FIELDS`, `comparable(field, value)`, `lglFields(c)`, `vgFields(p)` from `src/lgl-vg/fields.js`.
- Produces:
  - `resolveDate(spec, today)`: `'-30d'`, `'-2y'`, `'+0d'` → `'YYYY-MM-DD'` from `today` (`'YYYY-MM-DD'`); a literal date passes through; anything else throws naming the value.
  - `loadScenarios(modules)` → flat list; throws on a duplicate `name`, a missing `name`/`why`/`since`/`phases`, or an unknown key at scenario or phase level.
  - `selectScenarios(list, { only, step, overnight })` → `{ selected, skipped: [{ name, reason }] }`. `only` matches a name or an area (the file's basename); `step` (default 3) skips `since > step` with reason `since step N`; `overnight` scenarios are skipped unless `overnight: true`.
  - `phaseCount(selected)` → the largest `phases.length`.
  - `checkScenario({ scenario, phaseIndex, vgPersons, lglConstituent, holds, decisions })` → list of failures `{ phase, what, expected, found }`, where `vgPersons` is one person (or two for a couple) as `GET /persons?projection=detail` returns them, `holds` are this scenario's people's rows from `/sync/holds`, `decisions` are the pass's decision rows for this scenario's people. Rules:
    - `expect.vg` / `expect.lgl`: each named field from `FIELDS` compared with `comparable()` on `vgFields(p).<field>` / `lglFields(c).values.<field>`; `lastGiftDate` and `donor` (boolean: a donor row exists) compared as plain values. For a couple, `expect.vg` may be an array of two.
    - `expect.holds`: the set of open holds `{ field, reason }` must equal it exactly (order-free); an entry may add `state: 'dismissed'` to expect a dismissed one.
    - `expect.writes` / `expect.deferred`: counts of decision rows with `outcome` `write-vg` / `deferred`.
    - A phase beyond the scenario's own phases is checked as **undisturbed**: zero `write-vg` rows and no hold opened in that pass.
    - `expect.lgl.deleted: true`: the constituent is gone.

- [ ] **Step 1: Write failing tests.** At least: `resolveDate('-30d','2026-11-13')` → `'2026-10-14'`; `resolveDate('-2y','2026-11-13')` → `'2024-11-13'`; `resolveDate('soon')` throws; duplicate names throw; `selectScenarios` skips `since: 4` at step 3 with reason `since step 4`; `checkScenario` passes `'12 Elm Street'` against `'12 Elm St'` for `address`, fails `'401-555-0101'` against `'401-555-0102'` for `phones` with `what: 'vg.phones'`; holds equality fails on an extra open hold; an undisturbed check fails on one `write-vg` row in phase 3 of a 2-phase scenario.
- [ ] **Step 2: Run** `node --test test/harness/`. Expected: FAIL.
- [ ] **Step 3: Implement** both modules to the interface.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `"Harness: scenario loading, relative dates, expectations and lockstep"`

### Task 4: Guards

**Files:**
- Create: `harness/guards.js`
- Test: `test/harness/guards.test.js`

**Interfaces:**
- Produces:
  - `decideGuards({ env, lglCount, sentinelFound, foreignDonors })` (pure) → `{ ok: boolean, failed: [string] }`. Fails on: any required variable empty (`LGL_API_KEY`, `LGL_MEMBERSHIP_FUND_ID`, `LGL_PAYPAL_PAYMENT_TYPE_ID`, `VG_API_URL`, `VG_OIDC_URL`, `VG_CLIENT_ID`, `VG_CLIENT_SECRET`, `HARNESS_VG_CLIENT_ID`, `HARNESS_VG_CLIENT_SECRET`, `HARNESS_DB_CONTAINER`, `HARNESS_DB_PASSWORD`, `HARNESS_DB_SCHEMA`), `lglCount >= 200`, `!sentinelFound`, the host of `VG_API_URL` or `VG_OIDC_URL` not `localhost`/`127.0.0.1`, `HARNESS_DB_CONTAINER` equal to or starting with `village-green-demo`, or `foreignDonors > 0` (non-harness constituents with a gift). Each failure is a sentence naming the check.
  - `runGuards({ env, lglWriter, lglReader })` → same shape, gathering the inputs live (the sentinel is found by the name the spike uses, last name `Sentinel`, first name `Zztrial`).
- Adds `HARNESS_DB_CONTAINER=village-green-orch-db-1` to `.env.harness` and `.env.harness.example`.

- [ ] **Step 1: Write failing tests** for `decideGuards`: a complete local env passes; each listed failure fails alone with its own message; two failures report both.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: all pass. Then run the live guards once (`node -e` or a `--guards-only` flag kept for Task 7) and confirm they pass against the real setup.
- [ ] **Step 5: Commit** `"Harness: guards that both targets are the test ones"`

### Task 5: The VG side: staff client and reseed

**Files:**
- Create: `harness/vg-staff.js`, `harness/vg-db.js`
- Test: `test/harness/vg-staff.test.js`, `test/harness/vg-db.test.js`

**Interfaces:**
- Produces:
  - `createVgStaff({ apiUrl, oidcUrl, clientId, clientSecret, fetchImpl })` (client-credentials token, refreshed before expiry as `src/lgl-vg/vg.js` does) with: `createPerson(body)` → person (`POST /persons`, body per `PersonPost`), `patchPerson(id, body)`, `putDonor(id, { lglConstituentId, lastGiftDate })`, `deleteDonor(id)` if the API has it, `getPersons(lglConstituentId)` (`GET /persons?lglConstituentId=&projection=detail`), `getPerson(id)` (detail, via the list endpoint as `vg.js` does), `listHolds(states)`, `dismissHold(holdId, { dismissalKind, note })`, `acknowledgePrivacy()`.
  - `reseedVg(env, { spawn, exec })`: runs the generator (`npm run seed` in `HARNESS_GENERATOR_DIR`, default `~/dev/village-green/data`) with `VG_DB_HOST`, `VG_DB_PORT`, `VG_DB_USER`, `VG_DB_PASSWORD`, `VG_DB_SCHEMA` from the `HARNESS_DB_*` values and `VG_DEMO_DONORS=0`, streaming its output; then `restoreAccounts`.
  - `restoreAccounts(env, { exec })`: through `docker exec $HARNESS_DB_CONTAINER mysql -uroot -p... $HARNESS_DB_SCHEMA`, inserts the `user_data` rows for `service-account-vg-sync` and `service-account-vg-sync-harness`, a role 8 grant for the first, Admin and role 8 grants for the second (federation scope; read the `role_grant` columns and the Admin role id from the app's migrations, `~/dev/village-green/api/source/service/migrations/`). Then both accounts acknowledge privacy through the API (`vg-sync` via `npm run setup -- --env .env.harness`, the harness via `acknowledgePrivacy()`).
  - `sqlFor(...)` (pure) builds the statements, so they can be unit-tested; values are escaped, never interpolated raw.
- Adds `HARNESS_GENERATOR_DIR` to `.env.harness.example` (commented, with the default).

- [ ] **Step 1: Write failing tests** for `sqlFor` (the statements for both accounts; a quote in a username is escaped) and for `createVgStaff` with a fake `fetch` (token fetched once and reused; `dismissHold` posts to `/sync/holds/7/dismissal` with `{ dismissalKind: 'staff' }`).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`; then live: `reseedVg`, then `node src/lgl-vg/main.js full --env .env.harness` (dry). Expected: the pass signs in, reads 301 people, finds no linked pairs, and prints its summary. This proves Review Focus 5.
- [ ] **Step 5: Commit** `"Harness: VG staff client and dev-database reseed"`

### Task 6: Seeding scenarios into both systems

**Files:**
- Create: `harness/seed.js`
- Test: `test/harness/seed.test.js`

**Interfaces:**
- Consumes: Tasks 2, 3, 5.
- Scenario starting records (extends the design's example; Task 3's `loadScenarios` validates these keys):
  - `vg`: a `PersonPost` body, plus `deceased` and `deceasedDate` (applied with a PATCH after create). For a couple, an array of two.
  - `lgl`: constituent fields (`first_name`, `last_name`, `nick_name`, `suffix`, and the deceased fields Task 2 found), and `street_addresses`, `email_addresses`, `phone_numbers` as arrays of entry bodies (`{ number, type }` maps to LGL's phone type field as Task 2 found).
  - `gifts`: `[{ date, amount, dues?: true }]`; `dues: true` uses the stand-in fund and payment type.
  - `link` (default `true`), `couple` (default `false`).
- Produces:
  - `seedScenarios(selected, { lglWriter, vgStaff, env, today, log })` → state `{ seededAt, today, scenarios: { [name]: { constituentId, personIds: [..] } } }`. Order per scenario: create the constituent with the marker, its entries, its gifts; then the VG person(s); then, if `link`, `putDonor` with the constituent id and the last countable gift date.
  - `wipeLgl({ lglWriter, log })`: deletes every harness-marked constituent.
  - `applyEdit(edit, stateEntry, { lglWriter, vgStaff, today })` for phases: `edit.vg` (a `PersonPatch` body, to person 0, or `{ person: 1, ...}` for the other partner), `edit.lgl` (constituent fields; `entries: { <kind>: body }` updates the preferred entry of that kind, or adds one if there is none; `gifts: [...]` adds gifts; `delete: true` deletes the constituent), `edit.dismiss` (`{ field, reason, dismissalKind }`: dismiss that open hold).
  - The state is written to `out/harness-state.json`.

- [ ] **Step 1: Write failing tests** with fake writer and staff clients: call order for one scenario (constituent, entries, gifts, person, donor); a couple creates two persons and two donor rows with the same constituent id; `link: false` makes no donor row; a `dues` gift uses the fund and payment type ids from `env`; relative gift dates are resolved; `applyEdit` with `entries.phone_numbers` updates the preferred phone when one exists and adds one when none does.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `"Harness: seed scenarios into LGL and VG, and apply phase edits"`

### Task 7: The runner

**Files:**
- Create: `harness/run.js`, `harness/scenarios/` (empty but for one smoke scenario, `smoke.js`: everything agrees, two phases, `writes: 0` then `writes: 0`)
- Modify: `package.json` (script `"harness": "node harness/run.js"`), `README.md` (a "Test harness" section: setup, the command, the flags, what it touches)
- Test: `test/harness/run.test.js`

**Interfaces:**
- `npm run harness -- [--only <name|area>] [--step N] [--overnight] [--resume] [--guards-only]`. Every run reseeds unless `--resume` (which loads `out/harness-state.json` and continues at the saved phase). Records are left in place after a run for inspection; the next run wipes them first.
- Sequence: load `.env.harness` into an object (not `process.env`) → `runGuards` → `selectScenarios` (print the skipped with reasons) → `wipeLgl`, `reseedVg`, `seedScenarios` → for each phase `p` in `0..phaseCount-1`: apply every selected scenario's phase `p` edit, run its `wait` if any (`'verification'`: poll the scenario's addresses until `verified_on` is set, every 60 s, up to 15 minutes, then fail that scenario), run one pass (`node src/lgl-vg/main.js full --env .env.harness --write-vg --out out/harness-<stamp>/pass-<p+1>`, plus the phase's `args` if a scenario asks for, e.g. `['--max-people', '1']` only for scenarios that run alone), stream its output to the screen and to `pass-<p+1>.log`, read the pass's `full-*.jsonl`, fetch each scenario's people, constituent and holds, run `checkScenario` → write `report.txt` and print one line per scenario (`PASS name` / `FAIL name` then indented failures) and the totals → exit 1 if any failed or any pass exited non-zero.
- A phase's scenarios that set `runAlone: true` (breaker and drop-check scenarios) are not run in lockstep with the others: the runner runs them afterwards, one at a time, each with its own reseed of only its records (`--only` semantics).
- A pure `planRun({ selected, phaseCount })` returns the ordered step list (edits, waits, passes, checks) and is what `run.test.js` tests.

- [ ] **Step 1: Write failing tests** for `planRun`: two scenarios with 2 and 3 phases give three passes, with the shorter one checked as undisturbed in pass 3; a `runAlone` scenario comes after the lockstep group with its own reseed step.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the runner, the npm script and the README section.
- [ ] **Step 4: Run** `npm test`, then live `npm run harness 2>&1 | tee out/harness-smoke.log`. Expected: guards pass, reseed, `PASS smoke`, exit 0.
- [ ] **Step 5: Commit** `"Harness: the runner, npm run harness, and a smoke scenario"`

### Task 8: The step 3 scenarios

**Files:**
- Create: `harness/scenarios/{names,addresses,phones,emails,deceased,couples,gifts,holds,records,limits}.js`
- Modify: `src/lgl-vg/` only to fix a bug a scenario exposes (with a unit test reproducing it first, in the matching `test/lgl-vg/*.test.js`)

**Interfaces:**
- Consumes: everything above. Scenario names are kebab-case and say the behavior (`lgl-only-phone-fills-empty-vg-slot`).

Write one scenario per line below (the design's "The first set: step 3"), each with a `why` naming the design section or customer answer it proves. Every scenario's last phase is a pass that expects `writes: 0` and the same holds as the phase before.

- [ ] **Step 1: Write the scenarios:**
  - everything agrees: memory recorded, `writes: 0`, `holds: []`
  - a number only LGL has fills an empty VG slot; with no empty slot, `phones-no-slot`
  - a newer LGL gift date reaches VG; a `dues` gift does not count; a constituent whose only gift is dues gives `no-longer-donor` and no date write
  - first name, last name, nickname and suffix differing at the first pass are each held `never-agreed`, never changed
  - after agreement (phase 1), LGL changes the address, a phone and the last name (phase 2): VG follows each
  - after agreement, VG changes the email: phase 2 expects `deferred: 1` and LGL unchanged; `since: 3` (step 7's work changes it to expect the LGL write)
  - after agreement, LGL clears the email: `lgl-cleared`
  - deceased in LGL only (with a date): VG deceased with that date; after agreement, LGL removes it: `deceased-removed`, VG unchanged
  - an unclean LGL city (contains a digit): `unclean`
  - a couple: each partner's first name held `couple`; after agreement, a new shared LGL address reaches both
  - an over-long LGL value after agreement: `vg-refused` (or `unclean`, per the design); next pass no retry; dismissed (`staff`), it stays quiet; changed in LGL, observe and assert per Review Focus 3
  - a held first name fixed by hand in VG to match: the hold closes; a later LGL change to that name then reaches VG
  - the constituent deleted in LGL: `lgl-missing`; the Donor mark coming off is `since: 4`
  - `runAlone`: with `--max-people 1` and two people needing writes, the pass fails with the breaker and writes nothing
- [ ] **Step 2: Run** `npm run harness 2>&1 | tee out/harness-step3.log`. For each failure, decide: scenario wrong (fix the scenario, say why in the commit), sync bug (unit test first, fix in `src/`, rerun), or a disagreement with the design or the app (Review Focus 3 is the known candidate): record it in the ledger and the final report, mark the scenario's affected phase with a `known:` note, and continue.
- [ ] **Step 3: Run** `npm test` and the harness again. Expected: all scenarios PASS except any `known:` ones, which are listed.
- [ ] **Step 4: Commit** scenarios and any fixes in separate commits: `"Harness: the step 3 scenarios"`, and `"Fix: <what>, found by the harness"` per fix.

### Task 9: Close out

**Files:**
- Modify: `docs/superpowers/specs/2026-11-13-test-harness-design.md` ("Left to the builder" answered; anything the build changed), `docs/superpowers/specs/2026-11-11-lgl-vg-sync-design.md` (step 3 is done when the harness passes; any finding from Task 8)

- [ ] **Step 1:** Update both designs. Plain prose, no real data.
- [ ] **Step 2:** `npm test` and a final `npm run harness 2>&1 | tee out/harness-final.log`. Expected: as Task 8 Step 3.
- [ ] **Step 3: Commit** `"Designs: the harness as built; step 3 proven by its scenarios"`
