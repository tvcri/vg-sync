# Handoff: step 6, the change checks

2026-11-15. For the next session in this repo. Board item VG-202611-521
(#153 in `tvcri/village-green`); commits end with `Refs #153`.

## Where things stand

- **Step 5 is on `main`** (`b162219`, pushed), with this close-out on top.
  Design: `docs/superpowers/specs/2026-11-14-lgl-vg-step5-service-and-deploy-design.md`
  (the step 5 design). Its "What the rehearsal showed" has every result.
- `npm test` passes (477). The harness's full set passes: 38 of 38, with
  `--once full`.
- **Two images on Docker Hub,** `carlsmig/vg-sync`, both built from
  `b162219`:
  - A: `sha256:f3c49539b1dba06b0455237cfe6ccf2f637e70176d878044b9cfddd18e72af0d`
    (the push)
  - B: `sha256:0ffd7ae2cd894b18437e98993ea19bc02aa1f37f6e17b8fbc35a482842a41016`
    (run by hand; `:latest` at the time of writing)

  A push to `main` that changes more than `README.md` and `docs/**` builds
  another, so this close-out (it changes `CLAUDE.md`) will too.
- **The deployer, log shipping and alert script are in `vg-utils` `main`,**
  merged from branch `sync-deploy` as `3e9fc82` (the branch and its
  worktree are removed).
- **The two alerts were created 2026-11-15, disabled.** They are enabled at
  go-live with `alerts-sync.sh enable`. Azure rejects a 20-minute window,
  so `vg-sync-silent` uses 15 minutes, checked every 5 (as
  `vg-email-sidecar-silent`): three `SYNC ALIVE` lines are expected in each
  window.
- **The production service is not started,** and nothing on the VM has
  changed.
- **The dev VG database holds the harness's invented data** (the harness
  reseeded it, and the container rehearsal wrote to it). A snapshot taken
  before the first step 5 write is `out/dev-vg-before-step5.sql`; it holds
  the restored production snapshot, so it is real data.

## What step 5 added

- `src/lgl-vg/scheduler.js`: one job at a time; the nightly full pass at
  `FULL_PASS_UTC`; a failed pass retried an hour later, at most three times
  a night; nothing after a stop. Clock and timers are injected.
- `src/lgl-vg/service.js`: start-up (sign in, reach LGL, the three
  `STARTUP` markers, retries), `SYNC ALIVE` every five minutes, the pass
  ceiling (`PASS_TIMEOUT_MINUTES`), pruning of old decisions files
  (`pruneDecisions`), and the stop on `SIGTERM` or `SIGINT` (`STOPPING`,
  `STOPPED`, exit).
- `src/lgl-vg/pass.js`: reads raced against a stop; the run guard (one
  write run at a time, across processes).
- `src/lgl-vg/apply.js`: stops between writes; on a stop it saves memory
  and opens holds, but closes none.
- Client fixes: the VG token response is checked; the LGL client retries a
  network failure with the same 450-second backoff. A refused sign-in (a
  Keycloak 401 or `invalid_client`, an LGL 401) is final (not retried
  hourly); a VG or LGL 403 is not. Start-up checks VG then LGL inside one
  80-second budget (each try at most 15 seconds, three tries 20 seconds
  apart), so it ends within the deployer's 90-second gate. At start-up a
  VG 403 from `GET /user` is not retried, and an LGL 429 counts as reached
  (`STARTUP LGL reached (rate-limited)`). A signal during start-up stops at
  once.
- **Commands.** `node src/lgl-vg/main.js` with no command is the service.
  `--once full` replaced `full` (`npm run full` and the harness use it).
  `--once vg-check` and `--once lgl-check` are refused until step 6.
- **Configuration.** `WRITE_VG`, `FULL_PASS_UTC`, `OUT_DIR`,
  `DECISIONS_KEEP_DAYS`, `PASS_TIMEOUT_MINUTES`, `IMAGE_REVISION`
  (`.env.example`, README).
- **The image.** `Dockerfile` on `node:24-slim`, runs as `node` (uid 1000);
  `.env` and `out/` are bind mounts. `deploy/docker-compose.example.yml`
  shows the VM's compose entry.
- **CI.** `.github/workflows/publish-docker.yml`: on push to `main` and by
  hand, test, build, push `:<sha7>` and `:latest`, print the digest.
  `test.yml` stays the pull-request workflow.
- **In `vg-utils` `main` (merged as `3e9fc82`):** `vm-sidecar-deploy` takes a
  table of services, with `sync` beside `email` (`--service`,
  `SIDECAR_DEPLOY_STATE_DIR`, per-service rejected digests);
  `vm-logship` knows `tvcri-sync-1`, skips a missing container, and has
  `--no-ship`; `vm-sidecar-deploy/alerts-sync.sh` holds the two alerts.

## Go-live tasks for the engineer

All of these wait for the one go-live after step 7.

1. ~~Merge `vg-utils` branch `sync-deploy` into its `main`.~~ Done
   2026-11-15 (`3e9fc82`).
2. ~~Create both alerts, disabled (`alerts-sync.sh create`).~~ Done
   2026-11-15. Do not re-run `create` after `enable`: it disables them
   again.
3. On the VM, install the new `sidecar-deploy.py` and
   `ship-container-logs.py` (to `~/tvcri/sidecar-deploy/` and
   `~/tvcri/logship/`, as the deployer's README and the log shipper's
   docstring say).
   Both can go in before go-live: without a `sync` line or container, each
   skips it silently. Right after installing the deployer, before cron's
   next run, run `python3 sidecar-deploy.py --service email --dry-run`: the
   email path of the generalized deployer was checked only by reading and
   unit tests.
4. On the VM, create `vg-sync/out` owned by uid 1000 (`install -d -o 1000
   -g 1000 vg-sync/out`) and `vg-sync/.env`, readable by uid 1000.
5. Add `sync` to the VM's compose file, pinned by digest, as in
   `deploy/docker-compose.example.yml`.
6. `alerts-sync.sh enable`.

## Still open

- **A street name LGL's verification changes is copied to VG today.** The
  engineer's ruling (finding (d)) covers a rewrite of the town and ZIP; a
  changed street name or house number goes further. Proposed, not built or
  agreed: hold such a rewrite for staff instead of copying it. Whether VG
  should take it is the customer's call, for their question list.
- LGL's address verification rewrites even made-up streets in a real town.
  New scenarios use the town `Zzyzxford`, ZIP `00901`.
- "Telling staff" in the sync design: how held records reach staff.
- The Claude Doc copy of the sync design is stale; the repo copy is current.
- Trial experiments not yet run: addressee and salutation for other name
  shapes, verification of units and directionals, not-current emails and
  phones. Due before step 7.
- ~~Read the Azure "email sidecar silent" alert before step 5.~~ Done
  2026-11-14 (step 5 design, "The alerts").
- Left from the step 5 reviews, small: a read that stalls after the
  response headers fails the pass with a raw error message (still
  retried as a failed pass); tracked `.pyc` files in `vg-utils`
  (`vg-logs/`, `vm-logship/`).

## The harness and the village-green generator

The harness reseeds the dev VG database with village-green's demo-data
generator (`~/dev/village-green/data` by default). The engineer restarted
the dev VG API and the dev database is at migration 0034, matching that
checkout's generator, so the harness uses it again with no override. (The
step 5 harness run, with the database still at 0033, used village-green
`main`'s generator through a temporary `HARNESS_GENERATOR_DIR` line.)

## Step 6

The sync design's build step 6: the one-minute VG check and the five-minute
LGL check, including gifts, with their cursors and backoff. They are two
more jobs in the step 5 scheduler, not a rewrite. `--once vg-check` and
`--once lgl-check` arrive with them, and `SYNC ALIVE` gains the last time
of each check. Start with the sync design's "A change check".
