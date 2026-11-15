# vg-sync

Scheduled, headless synchronization between Little Green Light, Village Green
and Mailchimp for Village Common of Rhode Island.

Not built yet. See `docs/context-2026-11-11.md` for the background and the
open design questions, and `CLAUDE.md` for where the related projects live.

## Running the report

`npm run report` reads Little Green Light and Village Green and compares them.
It writes nothing to LGL or VG. It prints a summary of counts to standard
output and writes row-level details to a file under `out/`.

Configuration comes from environment variables, or a `.env` file in the working
directory. The variable names are listed in `.env.example`. The service account
needs a Keycloak client on the target VG and the Staff role there.

Three ways to run it:

- `npm run report` pulls LGL and VG live.
- `npm run report -- --save-snapshot` also saves the LGL pull to
  `out/lgl-snapshot-<timestamp>.json`.
- `npm run report -- --snapshot <file>` reads LGL data from a saved snapshot and
  makes no LGL request.

`--out <dir>` changes the output directory (default `out`).

The detail file (`out/report-<timestamp>.jsonl`) and any snapshot hold real
people. Do not commit or share them. `out/` is gitignored.

## Running the service

`npm start` (`node src/lgl-vg/main.js` with no command) runs the service. It
signs in to VG, reaches LGL, and prints three start-up lines:

```
STARTUP VG signed in as <username>
STARTUP LGL reached
STARTUP scheduler started write-vg=<on|off> nightly=<HH:MM>Z
```

A sign-in or LGL failure is tried three times, 20 seconds apart (a refused
sign-in only once), then it prints `STARTUP FAILED <reason>` and exits 1, as
it does for a configuration or policy-file error. Once started it runs a full
pass at once and then nightly at `FULL_PASS_UTC` (default `07:00`, UTC),
retries a failed pass an hour later (at most three times), and prints
`SYNC ALIVE ...` every five minutes. Each pass prints its `PASS` line, and
until the first successful full run with a constituent count, one line before
it saying the constituent-drop check is skipped. A
pass running longer than `PASS_TIMEOUT_MINUTES` (default 30, at most 1440) is
stopped and fails. It writes to VG only when `WRITE_VG=true`; otherwise every pass is a
dry run. Decisions files go to `OUT_DIR` (default `out`); those older than
`DECISIONS_KEEP_DAYS` (default 30) are deleted after each pass.

`SIGTERM` or `SIGINT` prints `STOPPING`, stops the running pass between
writes, prints `STOPPED` and exits 0.

## The image

The service ships as the Docker image `carlsmig/vg-sync`, built by
`.github/workflows/publish-docker.yml` on every push to `main` and tagged
`:<sha7>` and `:latest`. The image carries the commit in the
`org.opencontainers.image.revision` label and the `IMAGE_REVISION`
environment variable. It holds only `src/`, `package.json` and `policy.json`;
two things are bind mounts:

- `.env` to `/app/.env` (read-only)
- the decisions directory to `/app/out` (writable by the `node` user)

The host `out` directory must exist before the first start and be writable by
uid 1000, the image's `node` user (`install -d -o 1000 -g 1000 vg-sync/out`);
docker would otherwise create it root-owned, and the bind mount hides the
image's own chown. `.env` must be readable by uid 1000.

`deploy/docker-compose.example.yml` shows the `sync` service: pinned by
digest in the `repo@sha256:` form the deployer expects, `restart:
unless-stopped` and a 30 second stop grace period so a pass can stop cleanly.
To try it locally:

```
docker build --build-arg IMAGE_REVISION=$(git rev-parse HEAD) -t vg-sync:local .
```

## Running a full pass by hand

`npm run full` (`node src/lgl-vg/main.js --once full`) reads Little Green Light
and Village Green, decides every linked pair field by field from the sync
memory and `policy.json`, links or creates a VG person for each LGL donor with
no link (or holds it with a reason), removes the Donor mark from a person whose
LGL record is gone (or follows it to the record that replaced it), and prints a
summary followed by one line: `PASS OK full dry-run ...` or `PASS FAILED full
<reason>`. The line counts `links`, `creates` and `unlinks` beside the field
writes.

It is a dry run unless you add `--write-vg`. A dry run makes only read requests
to VG and none that change LGL. With `--write-vg` it records a run row in VG,
writes the planned changes, then the sync memory and holds, and closes the run
row. Nothing is ever written to LGL.

- `npm run full -- --write-vg` writes to VG.
- `--max-people <n>` raises the circuit breaker for this run. A write run
  refuses to continue when the plan changes more people than
  `CIRCUIT_BREAKER_PEOPLE` (default 50), or than `n` when given. A dry run
  still prints its summary, a line saying the breaker would trip, and
  `breaker=would-trip` on the PASS line. Read the decisions file before raising it.
- `--snapshot <file>` plans from a saved LGL snapshot and makes no LGL request.
  It cannot be combined with `--write-vg`: a snapshot would write stale LGL
  values into VG.
- `--out <dir>` changes the output directory (default `out`).

The pass also refuses to run when LGL returns more than
`MAX_CONSTITUENT_DROP_PERCENT` percent (default 10) fewer constituents than the
last successful full run. With no earlier successful full run it prints a line
saying the check was skipped.

Each pass writes `out/full-<timestamp>.jsonl`, one decision per line, once at
the end. It holds real people. Do not commit or share it. A failure before
planning (sign-in, a failed read, the constituent-count check) writes no file.
On a dry run the PASS line shows `holdsOpen` (open holds read) and
`holdsPlanned` (holds this pass wants). The summary's `holdsIfWritten` says what a write
run would do to the hold table (opened, seen, reopened, closed, left dismissed).

## Loading the import's decisions (once, before go-live)

`node src/lgl-vg/main.js seed-import --file <import-prod-*.json>` reads the
run file of the one-off LGL → VG import (`vg-utils/lgl-import/out/`) and loads
its decisions as holds, so the sync never undoes them: a staff Skip becomes a
permanent dismissal, a skip for an old last gift a rule dismissal, and a row
the import held an open `import-hold`. It is a dry run unless you add
`--write-vg`; it prints counts only, never a name. A constituent already
seeded, or linked in VG, is left out, so running it twice adds nothing. The
file holds real data: it stays in `vg-utils`, never in this repo.

## Setting up the service account

A restored database snapshot does not contain the service account. Until the
account exists in production, every restore leaves it with no user row, no role
and no privacy acknowledgement. `npm run setup` does the two parts the account
must do itself and says what a person must do in between. For a freshly
restored database:

1. Run `npm run setup`. The first request creates the user row. It prints the
   account's user name, then stops at the owed privacy acknowledgement.
2. In VG, grant the Staff role at federation level to the user name it printed.
3. Run `npm run setup -- --acknowledge-privacy`. This records the account's own
   acknowledgement of the current privacy rules, the only write this service
   makes to VG. It then checks that persons can be read and prints `SETUP OK`.
4. Run the report.

Repeat this after each restore, until the account exists in production.

## Test harness

The harness plays scenarios (invented people, `harness/scenarios/*.js`)
against the LGL trial account and a local dev VG, runs the real service
(`main.js --once full --write-vg`) between their phases, and checks both systems
afterwards. Design: `docs/superpowers/specs/2026-11-13-test-harness-design.md`.

Setup: copy `.env.harness.example` to `.env.harness` and fill it in. The LGL
key must be the trial account's; `node harness/discover.js --env .env.harness`
prints the fund and payment-type ids it needs. The dev VG stack must be up,
and the app's demo-data generator available (`HARNESS_GENERATOR_DIR`).

```
npm run harness -- [--only <name|area>] [--step N] [--overnight] [--resume] [--guards-only]
```

- `--only` runs the named scenario or every scenario in an area (a file name
  under `harness/scenarios/`); it may be repeated. A value that matches
  nothing is an error.
- `--step N` is the build step (default 3): scenarios with a later `since`
  are skipped, and the runner says so.
- `--overnight` includes scenarios that wait for LGL's overnight jobs; the run
  stops at such a wait and saves its state.
- `--resume` continues a saved run from `out/harness-state.json` without
  reseeding.
- `--guards-only` checks that both targets are the test ones (local hosts, the dev stack's ports, never the demo stack) and stops.

What it touches: the LGL trial account (it deletes every constituent carrying
the harness marker, then creates the scenarios'), and the dev VG database,
which every run reseeds whole with the generator. It refuses to start unless
the guards pass. It never touches production LGL or VG, Mailchimp, or the
demo stack. Records are left in place after a run for inspection; the next
run wipes them first.

Each run writes `out/harness-<time>/`: `pass-<n>/` with the pass's decisions
file and log, and `report.txt` with one `PASS`, `FAIL` or `KNOWN` line per scenario.
The run exits non-zero if a scenario failed or a pass exited non-zero.
Scenarios marked `runAlone` run after the others, each with its own reseed.
