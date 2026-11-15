# LGL ↔ VG step 5: the service and its deploy tooling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The hand-run full pass becomes a long-lived service (nightly full pass, heartbeat, clean shutdown), shipped as a Docker image by CI, with the deployer, log shipper and two alerts ready for go-live and rehearsed on the workstation.

**Architecture:** A scheduler (`scheduler.js`, injected clock and timers) runs one job at a time and a separate heartbeat timer. `service.js` does the start-up markers, owns one `AbortController` per pass (shutdown or the pass ceiling aborts it), and prunes decisions files. `runFullPass` and `applyPlan` learn to stop between writes. The deploy side lives in `~/dev/tvcri/vg-utils` (no remote): the deployer gains a service table, the log shipper a container and a `--no-ship` mode, and an `az` script defines the alerts.

**Tech Stack:** Node 24 ES modules, `node:test`, global `fetch`, no dependencies. Docker (`node:24-slim`), GitHub Actions, Docker Hub. Python 3 standard library for the vg-utils scripts. Azure CLI for the alerts.

**Spec:** `docs/superpowers/specs/2026-11-14-lgl-vg-step5-service-and-deploy-design.md` (the step 5 design), on top of `docs/superpowers/specs/2026-11-11-lgl-vg-sync-design.md` (the sync design). Read both.

## Global Constraints

- This repo is public: no real names, addresses, emails, LGL or VG ids in code, tests, fixtures, docs or commit messages. Invented people only (Jane Doe). Mask real values when reading output back.
- No runtime dependencies. Node ≥ 24.
- Every write path is dry-run by default. The service writes to VG only when `WRITE_VG=true`.
- Log strings are an interface, exactly: `STARTUP VG signed in as <username>`, `STARTUP LGL reached`, `STARTUP scheduler started write-vg=<on|off> nightly=<HH:MM>Z`, `STARTUP FAILED <reason>`, `PASS OK full ...` (unchanged), `PASS FAILED full <reason>`, `PASS STOPPED full <reason>`, `SYNC ALIVE last-full=<ISO|none> result=<ok|failed|running|none> next-full=<ISO>`, `STOPPING`, `STOPPED`.
- Defaults: `FULL_PASS_UTC=07:00`, `OUT_DIR=out`, `DECISIONS_KEEP_DAYS=30`, `PASS_TIMEOUT_MINUTES=30`; heartbeat every 5 minutes; retry a failed pass after 60 minutes, at most 3 retries; start-up tries 3 in all, 20 seconds apart; VG request timeout 60 s, LGL request timeout 120 s; compose `stop_grace_period: 30s`.
- Production is not touched: not the VM's compose file, cron, installed deployer or log shipper. Azure alerts are created only on the engineer's go-ahead, and disabled.
- Local dev VG writes: take a database snapshot before the first write of this step.
- Commits end with `Refs #153` and the `Co-Authored-By` line. Work on branch `lgl-vg-step5` from `main` (vg-utils changes commit on vg-utils `main`).
- Never pipe a long run through `tail`; stream it or `tee` it.

## Review Focus

1. **`SIGTERM` during the create sequence of an unlinked donor.** Expect the create to complete as a unit (hold, person, memory, donor, close), then stop. Test in Task 3 (`stop during a create finishes the create`).
2. **`SIGTERM` while a pass is still reading LGL** (no run row yet). Expect `PASS STOPPED`, no run row, no write, exit 0 within the grace period. Test in Task 4 (`stop before the run row opens writes nothing`).
3. **The nightly time comes due while the start-up pass (or a retry) is still running.** Expect it to wait and run once, not twice, and not to be lost. Test in Task 5 (`a due job waits for the running one and runs once`).
4. **A refused sign-in at start (wrong secret: `invalid_client`, 401).** Expect three tries, then `STARTUP FAILED` and exit 1, so the deployer's gate rejects the image. Test in Task 6 (`startup fails after three tries`).
5. **A by-hand `--once full --write-vg` while the service's pass runs.** Expect refusal with a plain message, no second run row. Test in Task 4 (`a write run refuses while another run is running`).

---

## File map

| File | Change |
|---|---|
| `src/lgl-vg/config.js` | New variables |
| `src/lgl-vg/vg.js` | Token validation, request timeout, `recentRuns` |
| `src/lgl-vg/lgl.js` | Network-error retry, request timeout, `probe` |
| `src/lgl-vg/apply.js` | `signal`; stop between writes; partial save |
| `src/lgl-vg/pass.js` | `signal`, `quiet`, `onResult`, run guard, final errors, `PASS STOPPED` |
| `src/lgl-vg/scheduler.js` | New: nightly + retry + heartbeat |
| `src/lgl-vg/service.js` | New: start-up, per-pass abort, shutdown, pruning |
| `src/lgl-vg/main.js` | No command → service; `--once full`; `full` removed |
| `harness/run.js`, `harness/scenario.js`, `package.json` | `--once full` |
| `Dockerfile`, `.dockerignore`, `.github/workflows/publish-docker.yml`, `deploy/docker-compose.example.yml`, `README.md`, `.env.example` | Image and CI |
| `~/dev/tvcri/vg-utils/vm-sidecar-deploy/sidecar-deploy.py`, `README.md`, `test_sidecar_deploy.py` | Service table |
| `~/dev/tvcri/vg-utils/vm-logship/ship-container-logs.py` | Sync container, skip missing, `--no-ship` |
| `~/dev/tvcri/vg-utils/vm-sidecar-deploy/alerts-sync.sh` | Alert definitions |
| `docs/…sync-design.md`, `docs/handoff-…-step6.md`, `CLAUDE.md` | Close-out |

---

### Task 1: Configuration

**Files:**
- Modify: `src/lgl-vg/config.js`, `.env.example`
- Test: `test/lgl-vg/config.test.js`

**Interfaces:**
- Produces: `loadConfig(env)` gains `writeVg: boolean`, `fullPassUtc: string` (`'HH:MM'`), `outDir: string`, `decisionsKeepDays: number`, `passTimeoutMinutes: number`. `imageRevision` unchanged.

- [ ] **Step 1: Write failing tests** in `config.test.js`:
  - `defaults for the service`: base env → `writeVg === false`, `fullPassUtc === '07:00'`, `outDir === 'out'`, `decisionsKeepDays === 30`, `passTimeoutMinutes === 30`.
  - `WRITE_VG is on only for "true"`: `'true'` → true; `'TRUE'`, `'1'`, `'yes'`, `''` → false.
  - `FULL_PASS_UTC must be HH:MM`: `'7:00'`, `'24:00'`, `'07:60'`, `'0700'` throw `/FULL_PASS_UTC must be HH:MM/`; `'23:59'`, `'00:00'` pass.
  - `PASS_TIMEOUT_MINUTES and DECISIONS_KEEP_DAYS are positive whole numbers`: `'0'` and `'x'` throw.
- [ ] **Step 2:** `node --test test/lgl-vg/config.test.js` → the new tests FAIL.
- [ ] **Step 3: Implement** in `config.js`. `WRITE_VG` compares `String(v).trim() === 'true'` (exactly lower case; anything else is a dry run). `FULL_PASS_UTC` regex `^([01]\d|2[0-3]):[0-5]\d$`. Add the five variables to `.env.example` as comments with their defaults, `WRITE_VG=` uncommented and empty.
- [ ] **Step 4:** `npm test` → all pass.
- [ ] **Step 5: Commit** `Config: the service's switches and timings`.

### Task 2: Client hardening

**Files:**
- Modify: `src/lgl-vg/vg.js`, `src/lgl-vg/lgl.js`
- Test: `test/lgl-vg/vg.test.js`, `test/lgl-vg/lgl.test.js`

**Interfaces:**
- Produces: `createVgClient({ …, timeoutMs = 60_000 })`; new method `recentRuns(limit = 20) -> Promise<SyncRun[]>` (`GET /sync/runs?limit=<n>`, all kinds, newest first as the API returns them); `lastFullRun()` unchanged in behavior. A token error caused by a refused sign-in carries `err.final = true` (Keycloak status 400 or 401 whose body contains `invalid_client` or `unauthorized_client`, or any 401).
- Produces: `createLglClient({ …, timeoutMs = 120_000 })`; new method `probe() -> Promise<void>` (`GET /constituents.json?limit=1`, throws on failure).

- [ ] **Step 1: Write failing tests.**
  - vg: `a token response without access_token fails plainly` → rejects `/token response has no access_token/`; `a token response without a positive expires_in fails plainly` → `/expires_in/`; `a refused client secret is final` → Keycloak 401 `{"error":"invalid_client"}` rejects with `err.final === true`; `a request that runs past the timeout fails` → fake fetch that honors `init.signal` and never resolves, `timeoutMs: 20` → rejects (error message contains `timed out`), not `final`; `recentRuns asks for all kinds` → URL path `/sync/runs?limit=20`.
  - lgl: `a rejected fetch is retried with backoff` → fetch throws `TypeError('fetch failed')` twice then 200; sleeps recorded `[30000, 60000]`; result returned; `a fetch that rejects every time fails after five tries`; `a request past the timeout counts as a network failure and is retried` (`timeoutMs: 20`, signal-honoring fetch that hangs on the first call); `probe asks for one constituent` → `limit=1`.
- [ ] **Step 2:** run both files → new tests FAIL.
- [ ] **Step 3: Implement.** Each fetch gets `signal: AbortSignal.timeout(timeoutMs)`; turn an abort into `Error('… timed out after <n> s')`. In `lgl.js` wrap the fetch in try/catch: a rejection is treated like a 429/5xx (same `BACKOFF_SECONDS`, same `MAX_ATTEMPTS`), rethrown on the last try. In `vg.js` validate `typeof body.access_token === 'string' && body.access_token` and `Number(body.expires_in) > 0`.
- [ ] **Step 4:** `npm test` → all pass.
- [ ] **Step 5: Commit** `Clients: request timeouts, LGL retries a failed fetch, VG checks its token`.

### Task 3: `applyPlan` stops between writes

**Files:**
- Modify: `src/lgl-vg/apply.js`
- Test: `test/lgl-vg/apply.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `applyPlan(plan, { vg, existingHolds, log, replan, signal = null })` → `{ counts, stopped: boolean }`. When `stopped`, it has: saved memory (`putSyncFields(agree)` as at the end today), created only the **new** holds the writes done produced (`reconcileHolds([...refusalHolds, ...u.holds], existingHolds).open`), and sent **no** `patchSyncHolds` from reconciliation. `counts.holds` reflects only what was opened. `applyUnlinked` takes `signal` and returns `{ holds, townMissing, stopped }`.

- [ ] **Step 1: Write failing tests** (fake `vg` as the file's existing tests build it; `signal` from an `AbortController`):
  - `an aborted signal stops before the first write`: abort before calling → no `patchPerson`, no `putDonor`, `stopped === true`, `putSyncFields` still called with `plan.agree`, `patchSyncHolds` not called.
  - `stop after one person write keeps that write's memory and refusal holds`: plan with two person writes, the first refused (422) on one field; abort inside the fake `patchPerson` of the first write → second write not attempted; `createSyncHolds` called once with the one `vg-refused` hold; no `patchSyncHolds`.
  - `stop during a create finishes the create`: abort inside the fake `createPerson` → `createSyncHolds` (create-unfinished), `putSyncFields`, `putDonor`, and `patchSyncHolds([{ holdId, state: 'closed' }])` all still called for that create; the next create is not attempted.
  - `a stopped pass never closes an existing hold`: an existing open hold that the full plan would close → not in any `patchSyncHolds` call.
  - `without a signal nothing changes`: one existing test re-run with `signal` omitted keeps its exact expectations (`stopped === false`).
- [ ] **Step 2:** `node --test test/lgl-vg/apply.test.js` → new tests FAIL.
- [ ] **Step 3: Implement.** Check `signal?.aborted` at the top of each loop iteration over writes (person writes, donor writes, unlinks, follows, before the `replan` read, links, finishes, creates). A create's body is not interrupted once begun; the patch for its create-unfinished hold is part of the create, not reconciliation. On stop, skip straight to the partial save described above.
- [ ] **Step 4:** `npm test` → all pass.
- [ ] **Step 5: Commit** `Apply: stop between writes on request, saving only what is safe`.

### Task 4: `runFullPass` for the service

**Files:**
- Modify: `src/lgl-vg/pass.js`
- Test: `test/lgl-vg/pass.test.js`

**Interfaces:**
- Consumes: `applyPlan(..., { signal })` → `{ counts, stopped }` (Task 3); `vg.recentRuns()` (Task 2); `config.passTimeoutMinutes` (Task 1); `err.final` on token errors (Task 2).
- Produces: `runFullPass({ …existing, signal = null, quiet = false, onResult = () => {} })`, still returning `0` (ok, or stopped by shutdown) or `1` (failed). `onResult({ outcome: 'ok'|'failed'|'stopped', retryable: boolean, error: string|null })` is called exactly once before return. `signal.reason` is `'shutdown'` or `'timeout'`.

Behavior:
- Check `signal?.aborted` after each read (`whoAmI`, LGL pull, persons, memory, holds, last run) and before `startRun`. Aborted with reason `'shutdown'` → `PASS STOPPED full stopped by shutdown`, outcome `stopped`, return 0. Aborted with reason `'timeout'` → `PASS FAILED full timed out after <n> minutes`, outcome `failed`, retryable true, return 1.
- `applyPlan` returning `stopped` → `finishRun(runId, { result: 'failed', …, error: 'stopped by shutdown' })` (or `'timed out after <n> minutes'`), decisions saved, the same `PASS STOPPED` / `PASS FAILED` line.
- **Run guard:** for a write run, before `startRun`, `vg.recentRuns()`; if any row has `result === 'running'` and `startedAt` within `passTimeoutMinutes` of `now()`, fail with `another sync run (id <runId>, <kind>) started at <startedAt> is still running; nothing was written` (retryable). Dry runs skip the guard.
- **Final errors** (`retryable: false`): circuit breaker trip, constituent-drop check, and any error with `err.final`. Everything else failed is retryable.
- `quiet: true` leaves out the JSON counts block (and only that).

- [ ] **Step 1: Write failing tests:**
  - `stop before the run row opens writes nothing`: signal aborted (`'shutdown'`) inside the fake LGL pull → no `startRun`, last line `PASS STOPPED full stopped by shutdown`, returns 0, `onResult` gets `{ outcome: 'stopped' }`.
  - `stop during apply records the run as failed by shutdown`: abort inside the fake `patchPerson` → `finishRun` with `result: 'failed', error: 'stopped by shutdown'`; line `PASS STOPPED …`.
  - `a timed-out pass fails and may be retried`: abort with `'timeout'`, `passTimeoutMinutes: 30` → `PASS FAILED full timed out after 30 minutes`, `onResult` `{ outcome: 'failed', retryable: true }`.
  - `a write run refuses while another run is running`: `recentRuns` returns `{ runId: 7, kind: 'full', result: 'running', startedAt: <now − 5 min> }` → no `startRun`, `PASS FAILED full another sync run (id 7, full) …`; a `running` row started 31 minutes ago does not block; a dry run with the 5-minute row is not refused.
  - `the circuit breaker and the drop check are final`: each → `retryable: false`. `a final token error is final`.
  - `quiet leaves out the counts block`: no stdout line starting `{`; the `PASS OK` line unchanged.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** as above. Mark the breaker and drop errors with `final = true` where they are thrown.
- [ ] **Step 4:** `npm test` → all pass.
- [ ] **Step 5: Commit** `Full pass: stops on request, refuses a second write run, says what may be retried`.

### Task 5: The scheduler

**Files:**
- Create: `src/lgl-vg/scheduler.js`
- Test: `test/lgl-vg/scheduler.test.js`

**Interfaces:**
- Produces:
  - `nextNightly(nowMs: number, hhmm: string) -> number`: the next instant strictly after `nowMs` at `hhmm` UTC.
  - `createScheduler({ now, setTimer, clearTimer, fullPassUtc, runFull, stdout, heartbeatMs = 300_000, retryDelayMs = 3_600_000, maxRetries = 3 })` → `{ start(): void, stop(): Promise<void> }`.
    - `runFull(): Promise<{ outcome: 'ok'|'failed'|'stopped', retryable: boolean }>`.
    - `setTimer(fn, ms) -> handle`, `clearTimer(handle)` (production: `setTimeout`/`clearTimeout`).
    - `start()` queues a full pass at once, arms the nightly and the heartbeat.
    - One job at a time: a full pass that comes due while one runs is queued once (a second due while one is queued is dropped).
    - After `failed` + `retryable`: queue a retry at `now + retryDelayMs`, up to `maxRetries` in a row; the counter resets after an `ok`. A non-retryable failure waits for the nightly. The nightly timer is always re-armed with `nextNightly` after it fires.
    - Heartbeat every `heartbeatMs` from `start()`: `SYNC ALIVE last-full=<ISO of last finished full pass, or none> result=<ok|failed|running|none> next-full=<ISO of the next nightly or retry, whichever is sooner>`. `result=running` while a pass runs (last-full still the last finished one).
    - `stop()`: clears all timers, drops queued jobs, resolves when the running job (if any) has returned.

- [ ] **Step 1: Write failing tests** with a fake clock and timer queue (a small helper in the test file: `advance(ms)` fires due timers in order, awaiting microtasks between them):
  - `nextNightly`: `('2026-11-14T06:59:00Z','07:00')` → `…T07:00:00Z` same day; `('2026-11-14T07:00:00Z','07:00')` → next day; `('2026-12-31T23:00:00Z','00:30')` → `2027-01-01T00:30:00Z`.
  - `start runs a full pass at once, then nightly`.
  - `a due job waits for the running one and runs once`: a `runFull` that takes 2 h of fake time starting 06:00; nightly at 07:00 → exactly two calls, the second after the first resolves.
  - `a retryable failure retries hourly, three times, then waits for night`: `runFull` always `{ failed, retryable: true }` from a start at 08:00 → calls at 08:00, 09:00, 10:00, 11:00, then the next at 07:00 next day.
  - `a final failure waits for night`.
  - `the heartbeat prints during a long pass`: `SYNC ALIVE last-full=none result=running next-full=…` at +5 min while the first pass runs.
  - `stop waits for the running pass and fires nothing after`.
- [ ] **Step 2:** run → FAIL (module missing).
- [ ] **Step 3: Implement** `scheduler.js`. Header comment: step 6 adds the VG and LGL checks as more jobs here.
- [ ] **Step 4:** `npm test` → all pass.
- [ ] **Step 5: Commit** `Scheduler: nightly full pass, retries, heartbeat`.

### Task 6: The service and the command line

**Files:**
- Create: `src/lgl-vg/service.js`
- Modify: `src/lgl-vg/main.js`, `harness/run.js` (`runPass` default command), `harness/scenario.js` (only if its messages name `full`), `package.json` (`"full"` script → `node src/lgl-vg/main.js --once full`; add `"start": "node src/lgl-vg/main.js"`)
- Test: `test/lgl-vg/service.test.js`, `test/lgl-vg/main.test.js`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:
  - `pruneDecisions({ dir, keepDays, now, readdir, stat, unlink }) -> Promise<number>`: deletes `full-*.jsonl` files in `dir` whose mtime is older than `keepDays`; returns the count; a missing `dir` is 0.
  - `startService({ config, policy, vg, lgl, stdout, now, setTimer, clearTimer, sleep, writeLines, fs }) -> Promise<{ stop(): Promise<void> } | null>`: runs the start-up (3 tries 20 s apart via `sleep` for each of `vg.whoAmI()` and `lgl.probe()`; final errors are not retried), prints the three `STARTUP` lines, then creates and starts the scheduler. Returns `null` after printing `STARTUP FAILED <reason>`. Each pass: a fresh `AbortController`; a timer at `passTimeoutMinutes` aborts it with `'timeout'`; `runFullPass({ …, writeVg: config.writeVg, quiet: true, out: config.outDir, signal, onResult })`; then `pruneDecisions`. `stop()` aborts the running pass with `'shutdown'` and awaits `scheduler.stop()`.
  - `main.js`: `run([])` (no command, only `--env`) starts the service; it registers `SIGTERM` and `SIGINT` handlers (injected as `deps.onSignal(name, fn)` for tests) that print `STOPPING`, await `stop()`, print `STOPPED`, and resolve `run` with 0. `STARTUP FAILED` → 1. `--once full [opts]` is today's `full` exactly. `--once vg-check` / `--once lgl-check` → `The VG and LGL checks arrive in step 6.` and 2. The bare `full` command is gone: `run(['full'])` prints usage and returns 2. Usage text updated.

- [ ] **Step 1: Write failing tests.**
  - service: `startup prints the three markers in order` (fake vg/lgl, `config.writeVg = true`, `fullPassUtc '07:00'`) → `STARTUP VG signed in as vg-sync`, `STARTUP LGL reached`, `STARTUP scheduler started write-vg=on nightly=07:00Z`.
  - `startup fails after three tries`: `whoAmI` rejects (network) every time → `sleep` called with `[20000, 20000]`, last line `STARTUP FAILED …`, result `null`; with a final error (`err.final`) → one try only.
  - `a pass past its ceiling is aborted with timeout`: fake `runFullPass` path via fake clients whose LGL pull hangs until signal; advance 30 min → `PASS FAILED full timed out after 30 minutes`.
  - `stop aborts the running pass with shutdown`.
  - `pruneDecisions deletes only old full-*.jsonl files`: files aged 31 and 29 days plus a `report-*.jsonl` aged 40 → only the first deleted, returns 1.
  - main: `--once full behaves as full did` (move the existing `full` tests to `--once full`); `the bare full command is gone`; `--once lgl-check is refused until step 6`; `no command starts the service and SIGTERM stops it` (fake fetch good for sign-in and probe; fire the captured `SIGTERM` handler; output contains `STOPPING` then `STOPPED`; resolves 0).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** `service.js` and the `main.js` changes; switch the harness's `runPass` default to `['--once', 'full', '--out', dir]`; update `package.json` scripts and the `README.md` usage.
- [ ] **Step 4:** `npm test` → all pass.
- [ ] **Step 5: Snapshot the dev database, then run the harness in full.** Snapshot: `docker exec village-green-orch-db-1 mysqldump -uroot -p"$HARNESS_DB_PASSWORD" --single-transaction vg > out/dev-vg-before-step5.sql` (values from `.env.harness`; `out/` is gitignored). Then say "running the full harness (about N minutes)" and run `npm run harness 2>&1 | tee out/harness-step5-task6.log`. Expected: all 38 scenarios pass.
- [ ] **Step 6: Commit** `Service: start-up markers, scheduler, clean stop; --once full replaces full`.

### Task 7: Image, CI and compose example

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `.github/workflows/publish-docker.yml`, `deploy/docker-compose.example.yml`
- Modify: `README.md` (a "Running the service" section)

**Interfaces:**
- Produces: image `carlsmig/vg-sync`, tags `:<sha7>` and `:latest`, label `org.opencontainers.image.revision`, env `IMAGE_REVISION` = the commit; compose service name `sync`, container in production `tvcri-sync-1`.

- [ ] **Step 1: Write the files.**
  - `Dockerfile`: `FROM node:24-slim`; `ENV NODE_ENV=production`; `WORKDIR /app`; `ARG IMAGE_REVISION=` then `ENV IMAGE_REVISION=$IMAGE_REVISION`; `COPY package.json policy.json ./`; `COPY src ./src`; `RUN mkdir -p /app/out && chown node:node /app/out`; `USER node`; comment that `.env` → `/app/.env` and the decisions directory → `/app/out` are bind mounts; `CMD ["node", "src/lgl-vg/main.js"]`.
  - `.dockerignore`: `.git`, `.env*`, `out`, `harness`, `spike`, `docs`, `test`, `node_modules`, `.superpowers`, `scratch`.
  - `publish-docker.yml`: copy of `~/dev/tvcri/vg-email-sidecar/.github/workflows/publish-docker.yml` with `DOCKERHUB_REPOSITORY: carlsmig/vg-sync`; no `npm ci` step and no npm cache (no lockfile); `build-args: IMAGE_REVISION=${{ github.sha }}`; title/description labels for vg-sync. Triggers: `workflow_dispatch` and push to `main` ignoring `README.md` and `docs/**`.
  - `deploy/docker-compose.example.yml`: service `sync`, `image: carlsmig/vg-sync@sha256:<digest>  # <commit>`, `restart: unless-stopped`, `stop_grace_period: 30s`, volumes `./vg-sync/.env:/app/.env:ro` and `./vg-sync/out:/app/out`, a comment that the pin line must keep the `repo@sha256:` form for the deployer. For the workstation rehearsal it notes `network_mode: host`.
- [ ] **Step 2: Build and smoke-test locally.** `docker build --build-arg IMAGE_REVISION=$(git rev-parse HEAD) -t vg-sync:local .` succeeds. `docker run --rm vg-sync:local node src/lgl-vg/main.js --once lgl-check` prints the step 6 message. `docker run --rm vg-sync:local` with no `.env` prints `STARTUP FAILED Missing environment variables: …` and exits 1. `docker image inspect` shows no `.env*`, `harness`, `test` in `/app` (`docker run --rm vg-sync:local ls -a /app`).
- [ ] **Step 3: Commit** `Image: Dockerfile, publish workflow, compose example`.

### Task 8: Container rehearsal on the workstation

No code unless the rehearsal finds a fault (then fix with a failing test first, in the owning module). Working directory: `out/rehearsal/` (gitignored). Record what was run and seen (masked) for the handoff.

- [ ] **Step 1:** `out/rehearsal/docker-compose.yml` from the example, `image: vg-sync:local`, `network_mode: host`, `.env` = a copy of `.env.harness` plus `WRITE_VG=true`, `FULL_PASS_UTC=<UTC now + 8 min>`, `PASS_TIMEOUT_MINUTES=30`. The harness's data is in the dev database from Task 6 (invented).
- [ ] **Step 2:** `docker compose up -d` then `docker compose logs -f sync | tee out/rehearsal/run1.log`. Expect within seconds the three `STARTUP` lines; then `PASS OK full write-vg …`; a `SYNC ALIVE` every 5 minutes including one while a pass runs; the nightly `PASS OK` at the set minute.
- [ ] **Step 3: Stop mid-write.** Make a write certain: edit one harness person in the dev VG (as the harness's staff client would, or a direct `UPDATE` of a donor's last name in the dev DB, which a pass will correct from LGL) and set `FULL_PASS_UTC` 2 minutes ahead, `docker compose up -d` to restart. When the pass is in its write phase (watch for the run row: `SELECT runId,result FROM sync_run ORDER BY runId DESC LIMIT 1` shows `running`), `docker compose stop sync`. Expect `STOPPING`, `PASS STOPPED full stopped by shutdown` (or, if it was still reading, the same line with no run row), `STOPPED`, exit within 30 s; the run row `failed` / `stopped by shutdown`. Restart: the start-up pass ends `PASS OK`.
- [ ] **Step 4: By-hand run beside the service.** While a service pass runs: `docker compose exec sync node src/lgl-vg/main.js --once full --write-vg` → refused with `another sync run … is still running`.
- [ ] **Step 5:** `docker compose down`. Note the results in the handoff draft.

### Task 9: Merge, push `main`, two CI images

**Gate:** the engineer has set `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` on `tvcri/vg-sync` (`gh secret list -R tvcri/vg-sync` shows both). If not, stop here and ask; Tasks 10–12 can proceed meanwhile, Task 13 cannot.

- [ ] **Step 1:** Check the branch for real data before it goes public: `git diff main...lgl-vg-step5` read in full for names, addresses, emails, ids. Also confirm `git log origin/main..main` holds no commit from `lgl-trial-findings`, `lgl-vg-step1` or `lgl-vg-design` (`git branch --contains` for 498022a, 340cbaa, aea1261 must not list `main`).
- [ ] **Step 2:** Squash-merge `lgl-vg-step5` into `main` as `LGL ↔ VG sync: step 5, the service and its image` (body ends `Refs #153` + co-author). `npm test` on `main` passes.
- [ ] **Step 3:** `git push origin main`. Watch: `gh run watch -R tvcri/vg-sync` on the Publish run. Expected: tests pass, image pushed, digest printed. Record digest A.
- [ ] **Step 4:** `gh workflow run publish-docker.yml -R tvcri/vg-sync --ref main`, watch it; record digest B (differs from A because of the `created` label). Confirm anonymous lookup works: `curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:carlsmig/vg-sync:pull"` returns a token, and a HEAD on `:latest` returns digest B.

### Task 10: Generalized deployer (vg-utils)

**Files:**
- Modify: `~/dev/tvcri/vg-utils/vm-sidecar-deploy/sidecar-deploy.py`, `README.md`
- Create: `~/dev/tvcri/vg-utils/vm-sidecar-deploy/test_sidecar_deploy.py`

**Interfaces:**
- Produces: `SERVICES` list of dicts `{name, repo, markers: [str], fail_re: re.Pattern, required: bool}`; functions take a service dict: `read_pin(svc) -> (index, digest, comment) | None` (None only when not `required` and no line; >1 line is always a `Failure`), `rejected(svc) -> set`, `reject(svc, digest, commit, reason)`, `container_id(svc)`, `wait_healthy(svc, prev_cid, expected_image, force_fail=False)`, `deploy(svc, old, old_commit, new, force_fail)`. CLI adds `--service NAME`. `STATE` from `SIDECAR_DEPLOY_STATE_DIR` (default `<script dir>/state`). Rejected-digests file: `state/rejected-digests` for `email`, `state/rejected-digests-<name>` for others. Log lines gain the service name after the verb: `DEPLOYED sync <old> (<c>) -> <new> (<c>)`, `FAILED deploy sync …`, `ROLLED BACK sync …`, `ROLLBACK FAILED sync …`; `email` lines get `email` too. Exit status: the worst over services (3 > 2 > 1 > 0).
- `sync` entry: repo `carlsmig/vg-sync`; markers `STARTUP VG signed in as`, `STARTUP LGL reached`, `STARTUP scheduler started`; `fail_re` `STARTUP FAILED|PASS FAILED|^\s*at .*\.js:\d+|Error: |invalid_client`; `required: False`. `email` entry: today's values, `required: True`.

- [ ] **Step 1: Write failing tests** (`python3 -m unittest test_sidecar_deploy` from the directory; tests write a temp compose file and point the module's `COMPOSE` at it):
  - `test_read_pin_email_required_missing_fails`, `test_read_pin_sync_missing_is_none`, `test_read_pin_two_lines_fail`, `test_read_pin_finds_each_repo` (a compose text with both services pinned).
  - `test_rejected_files_per_service`: email → `rejected-digests`, sync → `rejected-digests-sync`.
  - `test_sync_fail_re`: matches `PASS FAILED full x`, `STARTUP FAILED y`; does not match `PASS OK full write-vg people=0 …` or `SYNC ALIVE …`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** the table and parameterize the functions; `main()` loops `SERVICES` (or the one named by `--service`) under the one lock, skipping a non-required service with no pin silently. Update the docstring and `README.md` (service table, `--service`, state-dir override, per-service rejected files, log line forms; the alert query is unchanged because it matches `FAILED`).
- [ ] **Step 4:** tests pass; `python3 sidecar-deploy.py --help` works.
- [ ] **Step 5: Commit** in vg-utils: `vm-sidecar-deploy: a table of services; sync beside email`.

### Task 11: Log shipper (vg-utils)

**Files:**
- Modify: `~/dev/tvcri/vg-utils/vm-logship/ship-container-logs.py`

**Interfaces:**
- Produces: `CONTAINERS = ["tvcri-db-1", "tvcri-email-1", "tvcri-sync-1"]`; `CONTAINERS` overridable by `LOGSHIP_CONTAINERS` (comma-separated) and `BASE` by `LOGSHIP_BASE`, for rehearsal; a container that `docker inspect` says does not exist is skipped silently; `--no-ship` archives locally and neither queues for nor sends to Log Analytics nor uploads to blob storage, and needs no managed identity.

- [ ] **Step 1:** Implement. Keep the docstring accurate (new container, the two overrides, `--no-ship`).
- [ ] **Step 2: Verify.** `LOGSHIP_BASE=<scratch>/logship LOGSHIP_CONTAINERS=no-such-container python3 ship-container-logs.py --no-ship` exits 0 and prints nothing. (The real rehearsal is Task 13.)
- [ ] **Step 3: Commit** in vg-utils: `vm-logship: ship the sync container; skip missing containers; --no-ship for rehearsal`.

### Task 12: Alert definitions and query rehearsal

**Files:**
- Create: `~/dev/tvcri/vg-utils/vm-sidecar-deploy/alerts-sync.sh`; a section in that directory's `README.md`

**Interfaces:**
- Produces: `alerts-sync.sh create` (both alerts, disabled), `alerts-sync.sh enable`, `alerts-sync.sh show`. Names, queries, frequency, window and threshold exactly as the step 5 design's alerts table; resource group `village-green_group`; action group `vg-alerts`; scope the same Log Analytics workspace the existing `vg-email-sidecar-silent` uses (read its `scopes` with `az monitor scheduled-query show` at run time, not hard-coded).

- [ ] **Step 1:** Write the script with `az monitor scheduled-query create … --disabled true` (check `az monitor scheduled-query create --help` for the exact flag names on the installed CLI).
- [ ] **Step 2: Rehearse each query** against sample lines with `az monitor log-analytics query -w <workspace customer id> --analytics-query "<query with VmContainerLogs_CL replaced by a datatable(Container:string, Message:string)[...] of: ('tvcri-sync-1','PASS FAILED full x'), ('tvcri-sync-1','SYNC ALIVE last-full=none result=running next-full=x'), ('tvcri-sync-1','PASS OK full write-vg people=0'), ('tvcri-email-1','PASS FAILED full x')>"`. Expected: the failed query returns 1 row; the silent query's filter returns 1 row (and 0 rows when the `SYNC ALIVE` row is removed).
- [ ] **Step 3:** Commit in vg-utils: `Alerts for the sync service (created disabled)`.
- [ ] **Step 4: Ask the engineer for the go-ahead**, then run `alerts-sync.sh create` and `alerts-sync.sh show`; confirm both exist and are disabled.

### Task 13: Deployer and log-shipping rehearsal

Needs Task 9's two digests (A older, B = `:latest`).

- [ ] **Step 1:** `out/rehearsal/docker-compose.yml` (compose project `rehearsal`): service `sync` pinned `image: carlsmig/vg-sync@<digest A>  # <commit>`, `network_mode: host`, the rehearsal `.env` (`WRITE_VG=true`, harness env). No `email` service: a pinned email image would be deployed and gated for real. Run the deployer with `--service sync`. `email`'s unchanged behavior is covered by Task 10's tests and by one `--dry-run` without `--service` (expect `FAILED: expected one carlsmig/vg-email-sidecar@sha256 image line …`, exit 1, nothing changed).
- [ ] **Step 2:** `docker compose up -d` (digest A running). Then `SIDECAR_DEPLOY_COMPOSE_DIR=$PWD/out/rehearsal SIDECAR_DEPLOY_STATE_DIR=$PWD/out/rehearsal/state python3 ~/dev/tvcri/vg-utils/vm-sidecar-deploy/sidecar-deploy.py --service sync --dry-run` → `would deploy sync A -> B`. Without `--dry-run` → `DEPLOYED sync A (…) -> B (…)`, exit 0; the compose file's pin is B with the commit comment.
- [ ] **Step 3: Rollback.** Re-pin A by hand, `docker compose up -d`, run with `--fail-health-check` → `ROLLED BACK sync …`, exit 2, pin back to A, B in `state/rejected-digests-sync`. Run again → silent, exit 0 (B rejected). Remove B from the file.
- [ ] **Step 4: Gate failure for real.** Copy `.env` aside, set `VG_CLIENT_SECRET=wrong`, re-pin A, `up -d`, run the deployer → the new container prints `STARTUP FAILED …` → `FAILED deploy sync …` then `ROLLED BACK sync …`; note that the rolled-back container also fails with the bad secret (`ROLLBACK FAILED` is the expected outcome here, exit 3), which confirms the gate reads the sync markers. Restore `.env`.
- [ ] **Step 5: No pin, no noise.** Remove the `sync` service from the rehearsal compose file; run with `--service sync` → no output, exit 0.
- [ ] **Step 6: Log shipping.** With the rehearsal container running and named `rehearsal-sync-1` (compose project `rehearsal`): `LOGSHIP_BASE=$PWD/out/rehearsal/logship LOGSHIP_CONTAINERS=rehearsal-sync-1 python3 ~/dev/tvcri/vg-utils/vm-logship/ship-container-logs.py --no-ship`; the archive file `out/rehearsal/logship/archive/rehearsal-sync-1/<today>.jsonl` holds the `STARTUP` and `SYNC ALIVE` lines with `stream: stdout`. A second run adds only new lines.
- [ ] **Step 7:** `docker compose down`. Results into the handoff draft.

### Task 14: Close-out

**Files:**
- Modify: `docs/superpowers/specs/2026-11-11-lgl-vg-sync-design.md` (Build order step 5: done, with the rehearsal's results; "Rate limit": the client's backoff now totals 450 s; "Dry run": `full` is now `--once full`; "Deploy and operation": point at the step 5 design for the service table, alerts and log lines), `CLAUDE.md` (status), `README.md` if not already current
- Create: `docs/handoff-2026-11-14-step6.md` (or the actual date): where things stand, what step 5 added, what the engineer must do at go-live (install the deployer and log shipper on the VM, add `sync` to the VM compose file, `alerts-sync.sh enable`), still-open items carried from the step 5 handoff, step 6 next.

- [ ] **Step 1:** Write the docs. Check for real data.
- [ ] **Step 2:** `npm test` passes. Commit on `main`: `Step 5 done: design, handoff for step 6, CLAUDE.md status` (`Refs #153`). Push `main` (docs only; the publish workflow ignores `docs/**` but not `CLAUDE.md`, so expect one more image build).
- [ ] **Step 3:** Update the project memory (`vg-sync-status.md`) with the outcome.
