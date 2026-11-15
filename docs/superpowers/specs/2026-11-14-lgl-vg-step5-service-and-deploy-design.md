# LGL ↔ VG sync, step 5: the service and its deploy tooling

2026-11-14. Build step 5 of `2026-11-11-lgl-vg-sync-design.md` (the sync
design). This document covers only what that design leaves open for step 5;
where they overlap, the sync design stands. Board item VG-202611-521.

## Intent

Turn the hand-run full pass into the long-lived service the sync design
describes, and build everything needed to deploy, watch and roll it back,
so that the one go-live after step 7 is a matter of switching things on.
Step 5 is rehearsed on the engineer's workstation. Nothing about the
production VM, its compose file, its cron or its log shipping changes in
step 5, and the production service is not started.

## Goals

- `node src/lgl-vg/main.js` with no command starts the service: sign in,
  print the startup markers, start the scheduler, run a full pass at once
  and then nightly.
- `--once full` runs one full pass by hand and exits. It replaces the
  `full` command.
- `SYNC ALIVE` every five minutes, including while a pass runs.
- A clean stop on `SIGTERM` that never leaves a write half recorded.
- A Docker image built and pushed by CI on merge to `main`.
- The deployer in `vg-utils/vm-sidecar-deploy` generalized to a table of
  services, with `sync` beside `email`.
- `vm-logship` able to ship the new container.
- The two Azure alerts defined and created, disabled.

## Non-goals

- The one-minute VG check and the five-minute LGL check, their cursors
  and the backoff. Those are step 6. The scheduler is built so they are
  two more jobs in it, not a rewrite.
- Writes to LGL (step 7).
- Signed-JWT sign-in to Keycloak. **Deferred by the engineer
  (2026-11-14):** the service signs in with the client secret, in
  production too, until it is taken up again (step 7 or later).
- Any change to production: compose file, cron, the installed deployer or
  log shipper, or enabling the alerts.

## Anti-goals

- An alert that fires on an ordinary deploy, or a deploy that rolls back a
  good image because a pass was running.
- A second copy of the deployer rewriting the same compose file.
- Real data in this repo, in images, or in rehearsal files that are
  committed.

## Approaches

**The scheduler.** (a) A timer loop inside the Node process; (b) cron
inside the container running `--once full`. **Chosen: (a).** Step 6 adds
its checks to the same loop. Cron would have to be replaced in step 6, has
no long-running process to print a heartbeat, and is not the long-lived
service the sync design calls for.

**The deployer.** (a) Generalize `sidecar-deploy.py` to a table of
services; (b) a second copy for the sync service. **Chosen: (a)**, as the
sync design already decided: two copies would rewrite the same compose
file under separate locks.

**Where the rehearsal runs.** (a) The engineer's workstation; (b) the
production VM with a separately named container. **Chosen: (a)** by the
engineer (2026-11-14). The alerts are created in Azure but disabled until
go-live.

## The service

### Commands

```
node src/lgl-vg/main.js                         the service (scheduler)
node src/lgl-vg/main.js --once full [--write-vg] [--max-people N] [--out dir] [--snapshot file]
node src/lgl-vg/main.js report | seed-import | setup   unchanged
```

`--once full` takes the options `full` takes today and behaves exactly as
`full` does. The `full` command is removed, and the `npm run full` script
and the harness switch to `--once full`. `--once vg-check` and
`--once lgl-check` arrive in step 6; until then they are refused with a
plain message.

The service takes its write switch from `.env`: `WRITE_VG=true` writes to
VG; anything else is a dry run. `WRITE_LGL` is not read until step 7. A
dry-run service is useful in the rehearsal and is otherwise harmless: it
writes nothing, including run rows.

### Start

1. Load config and the policy file. Any error prints
   `STARTUP FAILED <reason>` and the process exits 1.
2. Sign in to VG and call `GET /user`. Print `STARTUP VG signed in as
   <username>`.
3. One cheap LGL request (the first page of constituents, `limit=1`).
   Print `STARTUP LGL reached`.
4. Start the scheduler. Print `STARTUP scheduler started write-vg=<on|off>
   nightly=<HH:MM>Z`.
5. The first job is a full pass, at once.

A failure in step 2 or 3 is tried three times in all, 20 seconds apart,
before `STARTUP FAILED`. **(call)** That fits inside the deployer's
90-second health gate, so a brief VG or Keycloak hiccup during a deploy
delays the markers rather than rolling back a good image. The markers
arrive in seconds on a normal start, long before the first full pass
(about two minutes) ends.

### The scheduler (`scheduler.js`)

- One job at a time. A job that comes due while another runs waits for it.
- Jobs in step 5: the full pass, and the heartbeat. The heartbeat is a
  separate timer and is not a job: it prints even while a pass runs.
- **Nightly full pass** at `FULL_PASS_UTC` (default `07:00`, that is 2 or
  3 a.m. in the customer's time zone). **(call)**
- **Retry after a failed pass:** an hour later, up to three retries, then
  wait for the next night. **(call)** Every failure prints `PASS FAILED`,
  so the failure alert fires; a retry that succeeds lets it resolve.
  Failures that would only repeat are **not** retried: the circuit
  breaker, the constituent-drop check, and a refused sign-in
  (`invalid_client`, 401, 403). They wait for the engineer or the next
  night. **(call)**
- **A hung pass.** Every VG and LGL request has a timeout (60 seconds for
  VG, 120 for an LGL page) and counts as a network failure when it runs
  out. A pass also has a ceiling, `PASS_TIMEOUT_MINUTES` (default 30): when
  it is reached the pass is asked to stop as on shutdown and reports
  `PASS FAILED full timed out`, so the failure alert fires. The heartbeat
  keeps printing throughout; the failure alert, not the silent one, is
  what catches a stuck pass. **(call)**
- **One write run at a time, across processes.** A by-hand write run
  (`docker compose exec sync node src/lgl-vg/main.js --once full
  --write-vg --max-people N`, the circuit breaker's override) could
  otherwise overlap a scheduled pass. Before a write run opens its run
  row, it reads the latest run rows and refuses if one is unfinished and
  started less than `PASS_TIMEOUT_MINUTES` ago. A dry run is never
  refused. **(call)** The usual way to override the breaker is still to run
  by hand while the service is stopped.
- The clock and timers are injected, so the scheduler is tested without
  waiting.

### Log lines

The sync design's strings stand: `PASS OK`, `PASS FAILED`, `SYNC ALIVE`.
Additions for step 5:

- `SYNC ALIVE last-full=<ISO time|none> result=<ok|failed|running|none>
  next-full=<ISO time>`, every five minutes from start. **(call)** Step 6
  adds the last time of each check.
- `PASS STOPPED full <reason>`: a pass ended by shutdown. Not an alert
  pattern.
- In the service, a full pass prints only its `PASS` line and, for a
  write run, nothing between. The JSON counts block that `--once full`
  prints is left out of the service's log, because each of its lines would
  be a separate log row in Azure. The counts are in the run row and the
  `PASS OK` line.
- `STOPPING` on `SIGTERM`, and `STOPPED` before exit.

### Decisions files

The service writes each pass's decisions file to `OUT_DIR` (default
`out`, bind-mounted from the VM in production) and deletes files there
older than `DECISIONS_KEEP_DAYS` (default 30). **(call)** These files hold
real data; they stay on the VM, which already holds the VG database, and
are not shipped to Azure.

### Shutdown

On `SIGTERM` or `SIGINT` the service prints `STOPPING`, stops the
scheduler and the heartbeat, and asks any running pass to stop.

- The pass checks for a stop **between writes**: before each write in
  `apply.js` and before the run row is opened. A write in hand finishes;
  the next is not started. A create counts as one write: its whole
  sequence (hold, person, memory, donor row, closing the hold) finishes
  together.
- **What is saved when a pass stops between writes. (call)** `apply.js`
  saves memory and reconciles holds once, at the end. On a stop it still
  saves memory (every row it holds is a value both sides agree on now) and
  still opens the holds the writes done so far produced (refusals). It
  does **not** close or reopen any hold: the hold reconciliation compares
  against the whole plan, and on a partial pass it could close a hold for
  a write that was never reached. The next pass reconciles everything.
- A pass stopped while it is still reading (the LGL pull, about 95
  seconds) is simply abandoned: nothing has been written.
- A stopped pass records its run row (if one was opened) as `failed` with
  the error `stopped by shutdown`, writes its decisions file, and prints
  `PASS STOPPED`, not `PASS FAILED`.
- The compose service gets `stop_grace_period: 30s`. A single VG write and
  its memory update take well under that.

### Client fixes owed since step 1

- **VG client:** validate the token response (an `access_token` string
  and a positive `expires_in`) and fail with a plain message otherwise.
- **LGL client:** retry a fetch that rejects (a network failure), with the
  same backoff as a 429 or 5xx. The backoff already outlasts LGL's
  five-minute pause (30 + 60 + 120 + 240 seconds), so the sync design's
  note that the ported client's fallback totals twelve seconds no longer
  applies; the design's text is corrected.

### Configuration added

| Variable | Default | Meaning |
|---|---|---|
| `WRITE_VG` | off | `true` lets the service write to VG |
| `FULL_PASS_UTC` | `07:00` | Nightly full pass, UTC, `HH:MM` |
| `OUT_DIR` | `out` | Where decisions files go |
| `DECISIONS_KEEP_DAYS` | `30` | Older decisions files are deleted |
| `PASS_TIMEOUT_MINUTES` | `30` | A pass running longer is stopped and fails |
| `IMAGE_REVISION` | from the image | Commit the image was built from; recorded in run rows |

## The image and CI (this repo)

- `Dockerfile` on `node:24-slim`, as the email sidecar's. No `npm ci`:
  the service has no dependencies. Copies `src/` and `policy.json`.
  `IMAGE_REVISION` is set from a build argument. Runs as `node`.
  `CMD ["node", "src/lgl-vg/main.js"]`.
- `.env` and the decisions directory are bind mounts, not in the image.
  `.dockerignore` keeps out `.env*`, `out/`, `harness/`, `spike/`,
  `docs/`, `test/`.
- `.github/workflows/publish-docker.yml`, copied from the email sidecar's:
  on push to `main` (ignoring `README.md` and `docs/**`) and by hand, run
  the tests, build `linux/amd64`, push `carlsmig/vg-sync:<sha7>` and
  `:latest` with the OCI labels, print the digest. No pull-request
  trigger; `test.yml` stays the pull-request workflow.
- The engineer has set up nothing in Docker Hub: the first push creates
  the repository. He adds `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` to
  the GitHub repo's secrets. The repository must stay public, because the
  deployer looks up `:latest` anonymously.

## The deployer (`vg-utils/vm-sidecar-deploy`)

`sidecar-deploy.py` keeps its shape and its one lock, and gains a table of
services. Each entry has: the compose service name, the image repository,
the startup markers, the failure pattern, and whether its pin line is
required.

| Service | Repository | Markers | Failure pattern | Pin required |
|---|---|---|---|---|
| `email` | `carlsmig/vg-email-sidecar` | as today | as today | yes |
| `sync` | `carlsmig/vg-sync` | the three `STARTUP` lines | `STARTUP FAILED`, `PASS FAILED`, `Traceback`-like crash text (`Error:` at line start from Node), `invalid_client` | no |

- Each run walks the table in order, one service at a time, under the one
  lock. Each service's digest check, deploy, health gate and rollback work
  exactly as they do for `email` today.
- **A service whose pin line is absent is skipped silently when it is not
  required.** That lets the generalized deployer be installed on the VM
  before go-live, with the sync service not yet in the compose file.
  `email` stays required, so its behavior is unchanged.
- Rejected digests are kept per service: `state/rejected-digests` keeps
  `email`'s for compatibility; others use `state/rejected-digests-<service>`.
  **(call)**
- `--service <name>` limits a by-hand run to one service. `--dry-run` and
  `--fail-health-check` are unchanged.
- `SIDECAR_DEPLOY_STATE_DIR` overrides the state directory, as
  `SIDECAR_DEPLOY_COMPOSE_DIR` already overrides the compose directory, so
  the rehearsal never touches production state.
- Log lines keep their form and gain the service name:
  `DEPLOYED sync <old> (<commit>) -> <new> (<commit>)`. The existing alert
  matches `FAILED` anywhere in the line, so it covers both services
  unchanged.
- `README.md` is updated to match.

## Log shipping (`vg-utils/vm-logship`)

- `tvcri-sync-1` is added to `CONTAINERS`. A container that does not exist
  is skipped silently, so the change can be installed before go-live
  without error lines. **(call)**
- A `--no-ship` flag reads and archives locally but sends nothing to Azure
  and needs no managed identity. The rehearsal uses it with
  `BASE` overridden to a scratch directory, to check that the sync
  container's lines are read and archived as expected.

## The alerts

Two scheduled-query alerts in resource group `village-green_group`, action
group `vg-alerts`, on the same workspace as the existing four. Created
**disabled** in step 5; enabled at go-live (step 7).

| Alert | Query | Every | Window | Fires when |
|---|---|---|---|---|
| `vg-sync-pass-failed` | `VmContainerLogs_CL \| where Container == 'tvcri-sync-1' \| where Message has_cs 'PASS FAILED' or Message has_cs 'STARTUP FAILED'` | 5 min | 15 min | count > 0 |
| `vg-sync-silent` | `VmContainerLogs_CL \| where Container == 'tvcri-sync-1' \| where Message has_cs 'SYNC ALIVE'` | 5 min | 20 min | count < 1 |

The silent alert follows `vg-email-sidecar-silent` (read 2026-11-14: any
line from `tvcri-email-1`, every 15 minutes over 15, fires below 1), with
two differences: it counts only `SYNC ALIVE`, so a chatty but stuck process
still alarms; and its window is the sync design's 20 minutes, checked every
5. The failed alert follows `vg-sidecar-deploy-failed`.

The `az` commands that create them are kept in `vg-utils` beside the
deployer (`vm-sidecar-deploy/alerts-sync.sh`), with the enable command for
go-live. Creating the alerts, even disabled, is a change to production
monitoring and is run only with the engineer's go-ahead.

## Rehearsal (on the workstation)

1. **Unit tests** for the scheduler, start, shutdown, the log lines, the
   client fixes and the decisions-file pruning (fake clock, fake fetch).
2. **The harness** still passes in full, running `--once full`.
3. **The container.** Build the image locally. Run it with Docker Compose
   from a scratch directory, `network_mode: host`, `.env.harness` mounted
   as `.env` with `WRITE_VG=true` and `FULL_PASS_UTC` set a few minutes
   ahead. Check: the three markers; the start-up pass's `PASS OK`;
   `SYNC ALIVE` on time during a pass; the nightly pass at the set time;
   `docker compose stop` in the middle of a write run gives `PASS
   STOPPED`, a `failed` run row with `stopped by shutdown`, and a clean
   next pass. Before the first write, snapshot the dev database, as the
   repo's rules require.
4. **The deployer.** With `SIDECAR_DEPLOY_COMPOSE_DIR` and
   `SIDECAR_DEPLOY_STATE_DIR` pointing at the scratch directory, whose
   compose file pins `sync` to an older digest: a run deploys `:latest`
   from Docker Hub and passes the gate; `--fail-health-check` rolls back;
   a compose file without a `sync` line is skipped silently; and the
   `email` behavior is checked against a stub `email` service in the same
   file. This needs the first image pushed by CI.
5. **Log shipping.** `--no-ship` against the rehearsal container archives
   its lines.
6. **The alerts.** Each query is run with `az monitor log-analytics
   query`, with the table replaced by a `datatable` of sample lines (a
   `PASS FAILED`, a `SYNC ALIVE`, an unrelated line), to show it matches
   what it should. Then the alerts are created disabled, on the engineer's
   go-ahead.

## Order of work and the push to GitHub

`origin/main` holds only the founding brief; steps 1 to 4 are local. The
deployer rehearsal needs CI-built images, and CI builds only on a push to
`main`. **Agreed with the engineer (2026-11-14):** `main` is pushed in the
middle of step 5. So the order is: the service, the image and the publish
workflow, with the unit tests and the full harness passing; then push
`main` (steps 1 to 4 with it) once the Docker Hub secrets are set; then a
second small push, so there are two images; then the deployer, log
shipping and alert rehearsals. The local branches that once held real
addresses (`lgl-trial-findings`, `lgl-vg-step1`, `lgl-vg-design`) are
never pushed.

## For the engineer to do

- Add `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` to `tvcri/vg-sync`.
- Go-ahead to create the two alerts, disabled.

## Left to the builder

- The exact wording of messages other than the strings this document and
  the sync design fix.
- How the stop request reaches `apply.js` (an `AbortSignal` is the
  obvious fit).
- The sync failure pattern's exact regular expression, once the service's
  real crash output has been seen in the rehearsal.
