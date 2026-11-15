# LGL ↔ VG step 6: the change checks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The service gains the one-minute VG check and the every-fifth-minute LGL check (one tick timer), with their cursors, the LGL cache, the idle backoff, the 15-minute failure rule, and `--once vg-check` / `--once lgl-check`.

**Architecture:** Pure planning for a check lives in `check-plan.js` (touched constituents, narrowing, the breaker count). `check.js` does a check's I/O and returns a result. It reuses `planLinked`, `planUnlinked`, `applyPlan` and the stop/race helpers now shared with `pass.js`. `scheduler.js` gains a `tick` job (VG check, then the LGL check every 5th or 15th tick) and the failure-reporting state. `service.js` owns the shared state (LGL cache and both cursors) and one `AbortController` per check. The full pass now sets the VG cursor by reading the change feed to its end, and hands its LGL pull back as the cache.

**Tech Stack:** Node 24 ES modules, `node:test`, global `fetch`, no dependencies.

**Spec:** `docs/superpowers/specs/2026-11-15-lgl-vg-step6-change-checks-design.md` (the step 6 design), on top of `docs/superpowers/specs/2026-11-11-lgl-vg-sync-design.md` (the sync design) and `docs/superpowers/specs/2026-11-14-lgl-vg-step5-service-and-deploy-design.md` (the step 5 design). Read all three; the step 6 design wins where they differ.

## Global Constraints

- This repo is public: no real names, addresses, emails, LGL or VG ids in code, tests, fixtures, docs or commit messages. Invented people only (Jane Doe). Mask real values when reading output back.
- No runtime dependencies. Node ≥ 24.
- Every write path is dry-run by default. Nothing in step 6 writes to LGL; `lgl.js` stays GET-only.
- Log strings are an interface, exactly: `CHECK OK <vg-check|lgl-check> <write-vg|dry-run> people=<n> writes=<n> deferred=<n> links=<n> creates=<n> holdsOpened=<n> holdsClosed=<n>`; `CHECK FAILED <kind> <message>`; `CHECK STOPPED <kind> <reason>`; `CHECK RECOVERED <kind>`; `PASS FAILED <kind> failing since <ISO>: <message>`; `PASS FAILED <kind> <message>` (final error or breaker); `SYNC ALIVE last-full=<ISO|none> result=<ok|failed|running|none> next-full=<ISO> last-vg-check=<ISO|none> last-lgl-check=<ISO|none> lgl-every=<5|15>m`. Step 5's strings are unchanged.
- Constants (not configuration): tick 60 s after the previous tick ended; LGL check every 5th tick, every 15th once neither check found a change for 60 min; at most 20 LGL reads per VG check; failures escalate after 15 min, repeat every 60 min; LGL 429 pause 5 min; `/op/state` timeout 5 s; feed page `limit` 1000.
- One new setting: `CHECK_TIMEOUT_MINUTES`, default 5, at most 60.
- `GET /constituents/{id}.json` is sent with **no query parameters** (`expand=` answers 403).
- A check never unlinks, never acts on `lgl-missing` or `no-longer-donor`, and never closes a hold whose `lglConstituentId` it did not touch.
- The sync design is updated in the same commit as the code that changes it (the feed rule, "only those are compared", `vgCursor` waiting for step 6, the commands, the check breaker, the more-than-20 rule, two timers → one tick).
- Commits end with `Refs #153` and the `Co-Authored-By` line. Work on branch `lgl-vg-step6` (exists, holds the design), in place, not in a worktree (the harness reads `.env.harness` from the repo root).
- Local dev VG writes: take a database snapshot before the first write of this step. Never pipe a long run through `tail`.

## Review Focus

1. **A touched constituent that already has an open `no-longer-donor` or `lgl-missing` hold.** The check drops those reasons from its plan, so it must also drop them from the existing holds it passes in, or `reconcileHolds` closes them. Expect the hold to stay open. Test in Task 2 (`record-level holds on a touched constituent are left alone`).
2. **A tick that falls due while the start-up full pass is still running, or before any full pass has succeeded.** Expect no check to run until a full pass succeeds, then ticks every 60 s. Test in Task 5 (`no tick before the first successful full pass`).
3. **The service is stopped while the LGL check of a tick is mid-read, after the VG check of the same tick succeeded.** Expect `CHECK STOPPED lgl-check`, the VG cursor advanced and the LGL cursor not, and nothing more scheduled. Test in Task 5 (`stop during the lgl check of a tick`).
4. **An LGL check that fails after some gifts were read.** Expect the cache unchanged, so the same gifts count as new on the retry. Test in Task 3 (`a failed lgl check leaves the cache and cursor unchanged`).
5. **A VG check whose touched people include someone linked to a constituent LGL now answers 404 for.** Expect that pair skipped (no hold, no unlink), the others decided, and the cursor advanced. Test in Task 3 (`a 404 constituent is left to the full pass`).

---

## File map

| File | Change |
|---|---|
| `src/lgl-vg/config.js`, `.env.example`, `README.md` | `CHECK_TIMEOUT_MINUTES` |
| `src/lgl-vg/lgl.js` | `getConstituent`, `constituentGifts`, `constituentsSince`, `giftsSince`; per-call `attempts` |
| `src/lgl-vg/vg.js` | `getChanges`, `getSyncFieldsFor`, `recentRuns` filters, `apiState` |
| `src/lgl-vg/abort.js` | New: the stop/race helpers, moved out of `pass.js` |
| `src/lgl-vg/check-plan.js` | New, pure: touched sets, narrowing, check plan, breaker count |
| `src/lgl-vg/check.js` | New: `runCheck` (I/O for both checks) |
| `src/lgl-vg/pass.js` | VG cursor from the feed; cache and cursors in `onResult` |
| `src/lgl-vg/scheduler.js` | `tick` job, counts, idle, escalation, halts, pause, heartbeat fields |
| `src/lgl-vg/service.js` | Shared state, per-check abort, `runCheck` wiring, pruning `checks-*.jsonl` |
| `src/lgl-vg/main.js` | `--once vg-check`, `--once lgl-check` |
| `harness/scenario.js`, `harness/run.js`, `harness/expect.js`, `harness/scenarios/checks.js` | Check phases, decisions files, step 6 scenarios |
| `docs/…sync-design.md`, `docs/handoff-2026-11-1x-step7.md`, `CLAUDE.md` | Kept in step; close-out |

---

### Task 1: Clients and configuration

**Files:**
- Modify: `src/lgl-vg/lgl.js`, `src/lgl-vg/vg.js`, `src/lgl-vg/config.js`, `.env.example`, `README.md`
- Test: `test/lgl-vg/lgl.test.js`, `test/lgl-vg/vg.test.js`, `test/lgl-vg/config.test.js`

**Interfaces:**
- Produces (LGL; each takes an optional last argument `{ attempts }`, default the client's 5; a final non-OK answer throws an error with `.status`, as now):
  - `lgl.getConstituent(id) → Promise<constituent>`: `GET /constituents/{id}.json`, no query string.
  - `lgl.constituentGifts(id) → Promise<gift[]>`: `GET /constituents/{id}/gifts.json`, paged like `fetchAll`.
  - `lgl.constituentsSince(iso) → Promise<constituent[]>`: `constituents/search` with `q[]=updated_from=<iso>` and the three expands, paged.
  - `lgl.giftsSince(date) → Promise<gift[]>`: `gifts/search` with `q[]=updated_from=<YYYY-MM-DD>`, paged.
- Produces (VG):
  - `vg.getChanges(after, limit = 1000) → Promise<{ lastAuditId: number, more: boolean, persons: { personId: string, changes: object[] }[] }>`: `GET /sync/changes?after=&limit=`.
  - `vg.getSyncFieldsFor(personIds: string[]) → Promise<row[]>`: `GET /sync/fields?personId=…` repeated, in chunks of 500, results concatenated. An empty list returns `[]` with no request.
  - `vg.recentRuns({ limit = 20, kinds = [], since = null } = {})`: adds `kind=` per kind and `since=`. **Existing callers pass a number today; keep `recentRuns(20)` working** (a number is `limit`).
  - `vg.apiState() → Promise<{ currentState, since, dependencies }>`: `GET /op/state`, **no Authorization header, no token request**, 5-second timeout, one attempt.
- Produces (config): `config.checkTimeoutMinutes` (default 5, bounded 1..60 with the existing `toBounded`).

- [ ] **Step 1: Write the failing tests**, using the fake-`fetch` pattern already in each file:
  - `getConstituent sends no query string` (assert the URL ends with `/constituents/42.json`).
  - `attempts: 1 does not retry a 429` (one fetch, error `.status === 429`).
  - `constituentsSince sends updated_from and the expands`; `giftsSince sends a bare date`.
  - `getChanges passes after and limit`; `getSyncFieldsFor chunks 501 ids into two requests`; `getSyncFieldsFor([]) makes no request`.
  - `recentRuns(20) still works`; `recentRuns with kinds and since builds kind=vg-check&kind=lgl-check&since=…`.
  - `apiState makes no token request and sends no Authorization header`.
  - `CHECK_TIMEOUT_MINUTES defaults to 5 and rejects 61`.
- [ ] **Step 2: Run** `node --test test/lgl-vg/lgl.test.js test/lgl-vg/vg.test.js test/lgl-vg/config.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** `get` in `lgl.js` already takes `{ attempts }`; thread it through `fetchAll` and the new methods. Add `CHECK_TIMEOUT_MINUTES` to `.env.example` and the README's configuration table.
- [ ] **Step 4: Run** the same command, then `npm test`. Expected: all PASS.
- [ ] **Step 5: Commit** `Step 6: client reads for the checks, CHECK_TIMEOUT_MINUTES`.

---

### Task 2: Check planning (pure)

**Files:**
- Create: `src/lgl-vg/check-plan.js`
- Test: `test/lgl-vg/check-plan.test.js`

**Interfaces:**
- Consumes: `planLinked`, `planUnlinked` (unchanged signatures), `RECORD_REASONS = new Set(['lgl-missing', 'no-longer-donor'])` (define here).
- Produces:
  - `mergeLglChanges(cache, { constituents = [], gifts = [] }) → { cache: Cache, touched: Set<string> }`. `Cache = { constituents: Map<string, constituent>, gifts: Map<string, gift> }`. **Pure: returns a new cache, never mutates the one given.** Every constituent given is touched and replaces its entry. A gift is touched (its `constituent_id`) only when its id is new or its JSON differs from the cached one.
  - `lglCursorAfter(cursor: string|null, constituents) → string|null`: the later of `cursor` and the newest `updated_at` given.
  - `vgTouched(changes, persons) → { touched: Set<string>, unlinked: number }`: constituent ids of the changed people that have a donor link.
  - `planCheck({ touched, cache, persons, memory, holds, policy, config, today }) → plan`: the plan shape `applyPlan` takes, plus `decisions`, `holds`, `counts`. Rules:
    - `planLinked` gets the touched linked constituents (from the cache), all cached gifts, the persons linked to them (every partner), `memory`, and refusals narrowed to touched.
    - From its result drop: `unlinks`, and every hold and decision whose reason/kind is in `RECORD_REASONS`.
    - `planUnlinked` gets **all** cached constituents and gifts, all persons, all `holds`, `unlinking: []`. Keep only the decisions, links, follows, creates, finishes and holds whose constituent is touched.
    - `existingHolds` (returned on the plan for `applyPlan`) = `holds` whose `lglConstituentId` is touched **and** whose reason is not in `RECORD_REASONS`.
    - `plan.replan(freshPersons) → unlinkedPlan`: `planUnlinked` again with `freshPersons` and `unlinking: []`, cut to touched the same way. Passed to `applyPlan` as its `replan`, whose call shape is `replan(freshPersons)` as in `pass.js`.
  - `breakerPeople(plan) → number`: people with a field write, link, follow, finish or create (a create counts once per constituent). A person whose only write is a `kind: 'donor'` write with nothing else does not count.
  - `foundChange(plan) → boolean`: true when the plan holds any decision whose outcome is not `same`, any hold, any agree row, or any unlinked action.

- [ ] **Step 1: Write the failing tests** (invented people; build fixtures the way `test/lgl-vg/plan.test.js` and `unlinked.test.js` do):
  - `an unchanged gift touches nothing`; `a changed gift touches its constituent`; `mergeLglChanges does not mutate the cache`.
  - `lglCursorAfter never moves backward`.
  - `vgTouched ignores people with no donor link`.
  - `a couple's partner is planned with the touched constituent`.
  - `holds on untouched constituents are not passed as existing` (existingHolds excludes them).
  - `record-level holds on a touched constituent are left alone` (an open `no-longer-donor` hold on a touched constituent is not in existingHolds and not desired: `reconcileHolds(plan.holds, plan.existingHolds)` closes nothing).
  - `a check never unlinks` (a touched linked constituent missing from the cache gives no unlink and no `lgl-missing` hold).
  - `a duplicate in LGL is held even when only one of the two is touched` (two unlinked donors matching one VG person by email and name, only one touched: its result is a `duplicate-in-lgl` hold, and nothing about the other appears).
  - `a look-alike of a dismissed donor is held, not created`.
  - `breakerPeople leaves out gift-date-only people`; `foundChange is false for an all-same plan`.
- [ ] **Step 2: Run** `node --test test/lgl-vg/check-plan.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `src/lgl-vg/check-plan.js` with the signatures above.
- [ ] **Step 4: Run** the test file, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `Step 6: check planning over touched constituents`. In the same commit, update the sync design's "A change check" (every field of a touched pair is compared; matching runs over all unlinked donors, results cut to touched; a check never unlinks).

---

### Task 3: `runCheck`, and the shared stop helpers

**Files:**
- Create: `src/lgl-vg/abort.js`, `src/lgl-vg/check.js`
- Modify: `src/lgl-vg/pass.js` (use `abort.js`; no behavior change)
- Test: `test/lgl-vg/check.test.js`; `test/lgl-vg/pass.test.js` must still pass unchanged

**Interfaces:**
- Produces (`abort.js`): `createStopper(signal, { label, minutes }) → { read(promise), checkStop(), stopError(), timedOut() }`, moved out of `runFullPass` as is. `label` is `'full'`, `'vg-check'` or `'lgl-check'`, used in the timeout message.
- Produces (`check.js`):
  ```
  runCheck({ kind, state, config, policy, vg, lgl, writeVg, now, writeLines, stdout, out,
             signal = null, lglAttempts = 1, lglPaused = false, quiet = false,
             maxLglReads = 20, fetchGifts = null })
    → Promise<{ outcome: 'ok'|'failed'|'stopped', final: boolean, breaker: boolean,
                rateLimited: boolean, foundChange: boolean, error: string|null }>
  ```
  `state = { cache: Cache|null, lglCursor: string|null, vgCursor: number|null }`. `runCheck` updates `state.cache`, `state.lglCursor` and `state.vgCursor` **only when the outcome is `ok`**.
- Consumes: Task 1's client methods, Task 2's functions, `applyPlan`, `reconcileHolds`.

Behavior, in order (the step 6 design, "What a check reads and decides", is the reference):

1. **VG check:** read the feed from `state.vgCursor`, following `more`. Touched = `vgTouched`. If none: set the cursor, return `ok`, `foundChange: false`, print nothing.
   **LGL check:** `constituentsSince(lglCursor − 2 min)` and `giftsSince(date(lglCursor) − 1 day)`; `mergeLglChanges` into a **copy** of the cache. If none touched: set cursor and cache, return quietly.
2. VG check with 1..`maxLglReads` touched: if `lglPaused`, fail with `LGL rate-limited`. Else `getConstituent` each (one attempt in the service), and `fetchGifts(id)` when given and the cache has no gifts for it (by hand only). A 404 drops that constituent from `touched` (left to the full pass). The fresh records go into the cache copy. With more than `maxLglReads` touched, no LGL reads: use the cache.
3. `listPersons`, `getSyncFieldsFor` (people linked to touched), `getSyncHolds(['open','dismissed'])`. `planCheck`.
4. Breaker: sum `counts.breakerPeople` of `recentRuns({ kinds: ['vg-check','lgl-check'], since: now − 24 h, limit: 1000 })` rows with `result === 'ok'`, plus `breakerPeople(plan)`. Over `config.circuitBreakerPeople`: with `writeVg`, write nothing and return `failed`, `breaker: true`, message `circuit breaker: <n> people changed by checks in 24 hours, more than the limit of <limit>`. A dry run prints `breaker=would-trip` and goes on.
5. With `writeVg` and `foundChange`: the run guard as in `pass.js`, `startRun({ kind })`, `applyPlan(plan, { vg, existingHolds: plan.existingHolds, replan: plan.replan, log, signal })`, `finishRun` with `counts` holding `peopleChanged` and `breakerPeople`, plus `lglCursor` and `vgCursor` (the new values). A quiet check writes no run row.
6. If `foundChange`, append the decisions (each with `check: kind` and `at`) to `<out>/checks-<YYYY-MM-DD>.jsonl`, and print the `CHECK OK` line (Global Constraints). If not `quiet`, also print the JSON counts block.
7. **Failures.** An error with `.final` (or a VG token refusal) gives `final: true`. A 429 from LGL gives `rateLimited: true`. A failure on a VG API request that is not a token request and not a 4xx answer gets one `vg.apiState()`, appended to the message as `(VG API <currentState> since <since>; <dep> down, …)`, or `(VG API state not reachable)`. A stop gives `outcome: 'stopped'`. `runCheck` prints nothing for a failure: the scheduler prints `CHECK FAILED` / `PASS FAILED` (Task 5). By hand, `main.js` prints it (Task 7).

- [ ] **Step 1: Move the helpers** to `abort.js` and run `node --test test/lgl-vg/pass.test.js`. Expected: PASS, unchanged.
- [ ] **Step 2: Write the failing tests** in `test/lgl-vg/check.test.js` with fake `vg` and `lgl` objects:
  - `a quiet vg check advances the cursor and prints nothing`.
  - `a vg edit plans to-lgl as deferred and writes nothing to LGL` (the fake `lgl` has no write methods; the decisions file holds `outcome: 'deferred'`).
  - `a 404 constituent is left to the full pass` (Review Focus 5).
  - `more than 20 touched uses the cache and makes no LGL read`.
  - `lglPaused fails a vg check that needs LGL reads, cursor unchanged`.
  - `an lgl check links a new donor who matches a VG person`.
  - `a failed lgl check leaves the cache and cursor unchanged` (Review Focus 4: `giftsSince` resolves, then `listPersons` rejects).
  - `the breaker counts ok check runs of the last 24 hours and trips without writing`; `gift-date-only runs do not trip it`.
  - `a 503 from VG adds the api state to the error`; `a 401 token refusal is final and makes no apiState call`.
  - `a stop during apply returns stopped and does not advance the cursor`.
- [ ] **Step 3: Run** `node --test test/lgl-vg/check.test.js`. Expected: FAIL.
- [ ] **Step 4: Implement** `src/lgl-vg/check.js`.
- [ ] **Step 5: Run** the test file, then `npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `Step 6: runCheck for the VG and LGL checks`. In the same commit, update the sync design's "Limits on checks" (breaker count without gift dates, cleared by a full pass; more than 20 uses the cache) and the "Cursors" paragraph on the feed (a gap, not "a few seconds old").

---

### Task 4: The full pass sets the VG cursor and hands back the cache

**Files:**
- Modify: `src/lgl-vg/pass.js`, `src/lgl-vg/service.js` (`pruneDecisions` only)
- Test: `test/lgl-vg/pass.test.js`, `test/lgl-vg/service.test.js`

**Interfaces:**
- `runFullPass` gains `vgCursorFrom = null` (a number: the cursor the service knows). Just before `listPersons`, it reads the feed through to its end from `vgCursorFrom`, else the newest run row with non-null `vgCursor` (`recentRuns({ limit: 50 })`), else 0, and ignores the content.
- `onResult(result)` for an `ok` pass now also carries `lgl: { constituents, gifts }` (not for a snapshot run), `lglCursor` (as `lglCursorOf`) and `vgCursor`. `finishRun` records `vgCursor` instead of `null`.
- `pruneDecisions` also deletes `checks-*.jsonl` by the same age rule.

- [ ] **Step 1: Write the failing tests:** `a full pass records the feed end as vgCursor`; `the feed is read from the newest run row's cursor when the service knows none`; `onResult carries the pull and both cursors`; `pruneDecisions deletes old checks files`.
- [ ] **Step 2: Run** `node --test test/lgl-vg/pass.test.js test/lgl-vg/service.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `Step 6: the full pass sets the VG cursor`. In the same commit, remove the sync design's "(call) The VG cursor waits for step 6" paragraph and describe the feed read.

---

### Task 5: The scheduler's tick

**Files:**
- Modify: `src/lgl-vg/scheduler.js`
- Test: `test/lgl-vg/scheduler.test.js`

**Interfaces:**
- `createScheduler` gains `runCheck(kind, { lglPaused }) → Promise<CheckResult>` (Task 3's result shape; the scheduler passes `lglPaused: now() < lglPausedUntil`) and `tickMs = 60_000`. `runFull()` now resolves `{ outcome, retryable }`, as in step 5.
- Scheduler state (all in the closure): `checksOn` (false until a full pass returns `ok`), `halted: null|'final'|'breaker'` (cleared by a full pass `ok`), `ticksSinceLgl`, `lastChangeAt` (set to `now()` at `start()`), `lglPausedUntil`, and per kind `{ failingSince, lastAlertAt, lastOkAt }`.

Rules:
- After every `ok` full pass: `checksOn = true`, `halted = null`, and arm the tick timer if none is armed.
- A tick is queued like any job (`tick`, at most one waiting). Running a tick: `ticksSinceLgl++`. Run `runCheck('vg-check')`. Then, unless `halted` or the stop has begun: if `ticksSinceLgl >= every()` and `now() >= lglPausedUntil`, run `runCheck('lgl-check')` and set `ticksSinceLgl = 0`. `every() = now() − lastChangeAt >= 60 min ? 15 : 5`.
- After each check: `foundChange` sets `lastChangeAt = now()`. `rateLimited` sets `lglPausedUntil = now() + 5 min`. `final` prints `PASS FAILED <kind> <error>` and sets `halted = 'final'`. `breaker` prints the same and sets `halted = 'breaker'`. Any other failure prints `CHECK FAILED <kind> <error>` and applies the 15-minute rule (the design, "Failures and log lines"). On `ok` after a `PASS FAILED`, print `CHECK RECOVERED <kind>`. Then reset that kind's failure state. `stopped` prints `CHECK STOPPED <kind> <reason>` and nothing more is scheduled.
- When a tick ends (any outcome), arm the next tick `tickMs` later, unless stopping. While `halted`, ticks still fire but run no check.
- `SYNC ALIVE` gains `last-vg-check`, `last-lgl-check` (each kind's `lastOkAt`) and `lgl-every=<every()>m`.
- A `runCheck` that throws is treated as `{ outcome: 'failed', error: <message> }`.

- [ ] **Step 1: Write the failing tests** with the fake clock and timers already in `scheduler.test.js`:
  - `no tick before the first successful full pass` (Review Focus 2).
  - `ticks every 60 s after the previous tick ended`; `a slow tick does not stack`.
  - `the lgl check runs on every fifth tick`; `after an idle hour, every fifteenth`; `a change while at fifteen returns to five, at once if five ticks have passed`.
  - `a tick due during a full pass waits and runs once`; `a nightly pass due during a tick waits for it`.
  - `a failed vg check is still followed by the lgl check due on that tick`.
  - `CHECK FAILED until 15 minutes, then PASS FAILED once, again after 60 minutes, then CHECK RECOVERED`.
  - `a final error halts checks until a full pass succeeds`; `the breaker halts checks until a full pass succeeds`.
  - `a 429 puts the lgl check off for five minutes`.
  - `stop during the lgl check of a tick` (Review Focus 3).
  - `SYNC ALIVE shows both check times and lgl-every`.
- [ ] **Step 2: Run** `node --test test/lgl-vg/scheduler.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test file, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `Step 6: the scheduler's tick`. In the same commit, update the sync design's "Shape" and the "Checks and the full pass" table (one tick; the LGL check every fifth tick) and "The LGL check backs off when idle".

---

### Task 6: The service wires the checks

**Files:**
- Modify: `src/lgl-vg/service.js`
- Test: `test/lgl-vg/service.test.js`

**Interfaces:**
- `startService` keeps one `state = { cache: null, lglCursor: null, vgCursor: null }`. `runFull` passes `vgCursorFrom: state.vgCursor`, and on an `ok` result sets `state.cache` (as Maps) and both cursors from `onResult`.
- `runCheck(kind)` for the scheduler: a fresh `AbortController`, aborted with `'timeout'` after `config.checkTimeoutMinutes` and with `'shutdown'` by `stop()`. It has the scheduler's call shape `runCheck(kind, { lglPaused })` (Task 5) and calls Task 3's `runCheck` with `writeVg: config.writeVg`, `lglAttempts: 1`, `quiet: true` and that `lglPaused`.
- A check that hits its ceiling resolves `failed` with `timed out after <n> minutes` (not `stopped`).

- [ ] **Step 1: Write the failing tests:** `checks start after the start-up pass`; `a check ceiling fails the check, not the service`; `stop aborts a running check`; `the cache from the full pass reaches the lgl check`.
- [ ] **Step 2: Run** `node --test test/lgl-vg/service.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test file, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `Step 6: the service runs the checks`.

---

### Task 7: `--once vg-check` and `--once lgl-check`

**Files:**
- Modify: `src/lgl-vg/main.js` (usage text included), `README.md`
- Test: `test/lgl-vg/main.test.js`

**Interfaces:**
- `--once vg-check [--write-vg] [--after <auditId>] [--out <dir>]`. The cursor is `--after`, else the newest run row's non-null `vgCursor`. With neither, print `No VG cursor: give --after <auditId>` and exit 2. Its cache starts empty. For each touched constituent it reads `getConstituent` and `constituentGifts`, with the full pass's retries (`lglAttempts: 5`).
- `--once lgl-check [--write-vg] [--since <ISO>] [--out <dir>]`. The cursor is `--since`, else the newest run row's non-null `lglCursor`. With neither, exit 2 with `No LGL cursor: give --since <ISO time>`. It builds the cache with `pullConstituents` and `pullGifts`, then runs one check (`lglAttempts: 5`).
- Both: `quiet: false`. They print `CHECK FAILED <kind> <message>` and exit 1 on failure (no 15-minute rule), and exit 0 on success. `--snapshot` and `--max-people` give `Unknown option`.
- `--once vg-check` passes `maxLglReads: Infinity` (its cache starts empty, so it must read every touched constituent) and `fetchGifts: (id) => lgl.constituentGifts(id)`.

- [ ] **Step 1: Write the failing tests:** `vg-check refuses with no cursor`; `vg-check takes --after`; `lgl-check takes the cursor from the newest run row`; `a check by hand is dry without --write-vg`; `--snapshot is refused`.
- [ ] **Step 2: Run** `node --test test/lgl-vg/main.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Remove the "arrive in step 6" refusal.
- [ ] **Step 4: Run** the test file, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `Step 6: the checks by hand`. In the same commit, update the sync design's "Dry run" commands.

---

### Task 8: Harness: check phases and step 6 scenarios

**Files:**
- Modify: `harness/scenario.js`, `harness/run.js`, `harness/expect.js` (only if the counts need it)
- Create: `harness/scenarios/checks.js`
- Test: `test/harness/scenario.test.js`, `test/harness/run.test.js`

**Interfaces:**
- A phase's `run` may be `'full'`, `'lgl-check'` or `'vg-check'`. A scenario with any check phase must be `runAlone` (each check reads a cursor that the scenario's own earlier pass set). `loadScenarios` rejects a check phase outside `runAlone`.
- `planRun` puts `run` on the `pass` step. `runPass` uses `['--once', run, '--out', dir]`, and `--write-vg` as now.
- `readDecisions(dir)` reads `full-*.jsonl` or, failing that, `checks-*.jsonl`.
- `selectScenarios`' `step` default and `--step` default become 6.

Scenarios (`since: 6`, all `runAlone`; town `Zzyzxford`, ZIP `00901` for any new address, per the handoff):

1. `lgl-name-edit-reaches-vg-by-lgl-check`: full; LGL first-name edit, `lgl-check`, VG has the new name, `writes: 1`.
2. `new-gift-moves-last-gift-date-by-lgl-check`: full; add a gift at `-2d`, `lgl-check`, `vg.lastGiftDate` is `-2d`.
3. `first-gift-links-matching-person-by-lgl-check`: a VG person and an LGL constituent with the same name and email, no gift; full (nothing linked); add a gift, `lgl-check`, VG person has `donor: true`.
4. `vg-edit-is-deferred-by-vg-check`: full; VG email edit, `vg-check`, `deferred: 1`, `writes: 0`, LGL unchanged.
5. `check-leaves-untouched-hold-open`: two pairs, one with a seeded `both-changed` hold; full; LGL edit on the other, `lgl-check`, the hold is still open.

- [ ] **Step 1: Write the failing tests:** `a check phase outside runAlone is rejected`; `planRun puts the run kind on the pass step`; `step defaults to 6`.
- [ ] **Step 2: Run** `node --test test/harness/`. Expected: FAIL.
- [ ] **Step 3: Implement** the harness changes and write the five scenarios.
- [ ] **Step 4: Run** `node --test test/harness/` and `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `Step 6: harness check phases and scenarios`.

---

### Task 9: Harness run and container rehearsal (the driving session runs this)

Not for an implementer subagent (handoff lessons 5 and 7).

- [ ] **Step 1:** Compare `~/dev/village-green/data`'s generator migration with the dev database's (`SELECT MAX(...)` on the migrations table, using the `mysql:8.4` container). If they differ, point `HARNESS_GENERATOR_DIR` at a matching checkout for this run.
- [ ] **Step 2:** Snapshot the dev VG database (`vg-utils/mysql-dump`) to `out/dev-vg-before-step6.sql`.
- [ ] **Step 3:** `npm run harness 2>&1 | tee out/harness-step6.log`. Expected: every scenario passes (38 earlier + 5 new). Fix what fails in the owning task's files, then rerun.
- [ ] **Step 4:** The container, as in the step 5 rehearsal (`.env.harness` as `.env`, `WRITE_VG=true`, `network_mode: host`). Check:
  - the start-up pass, then `SYNC ALIVE` with `last-vg-check` set within two minutes;
  - a first-name edit on a trial constituent gives `CHECK OK lgl-check` within six minutes, and VG shows it;
  - a VG email edit gives `CHECK OK vg-check … deferred=1`;
  - `docker compose stop` during a tick gives `STOPPING`, `STOPPED`, and no `PASS FAILED`.

  Record the results in the step 6 design under "What the rehearsal showed".
- [ ] **Step 5:** Production dry run: restore a production snapshot into the dev database, then run `--once full`, `--once vg-check` and `--once lgl-check` (no `--write-vg`) against production LGL. Confirm each exits 0 and the counts look plausible. Mask real values in anything read back.
- [ ] **Step 6: Commit** the design's rehearsal notes.

---

### Task 10: Close-out

- [ ] **Step 1:** Write `docs/handoff-<date>-step7.md` on the pattern of the step 6 handoff: where things stand, what step 6 added, go-live tasks (unchanged plus any new), still open, lessons from the step 6 build.
- [ ] **Step 2:** Update `CLAUDE.md`'s status paragraph and the sync design's build-order entry for step 6 ("Done <date>: …").
- [ ] **Step 3:** Scan the branch for real data: `git diff main --stat` and grep the diff for anything that looks like a real name, address, email or id. Expected: nothing.
- [ ] **Step 4: Commit** `Step 6 close-out`. Do not merge or push; the engineer decides the merge style, and a push to `main` builds an image.
