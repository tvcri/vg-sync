# vg-sync

Scheduled, headless synchronization between Little Green Light, Village Green
and Mailchimp for Village Common of Rhode Island.

The LGL ↔ VG sync is built; the VG → Mailchimp executable is described under "VG → Mailchimp audience" below. A reference to
every command, option, variable and output line is in
[`docs/vg-sync.1.md`](docs/vg-sync.1.md). The rules file is described in
[`docs/policy.json.5.md`](docs/policy.json.5.md). `CLAUDE.md` says where the related
projects live; `docs/context-2026-11-11.md` is the founding brief.

## Running the report

`npm run report` reads Little Green Light and Village Green and compares them.
It writes nothing to LGL or VG. It prints a summary of counts to standard
output and writes row-level details to a file under `out/`.

Configuration comes from environment variables, or a `.env` file in the working
directory. The variable names are listed in `.env.example`. The service account
needs a Keycloak client on the target VG and the Sync Service role there
(role 8, at federation level).

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
signs in to VG, reaches LGL, and prints three start-up lines. Every line the
service prints starts with the time it was written (ISO, UTC), shown below
without it; commands run with `--once`, `setup` or `seed-import` print
without a time.

Its three start-up lines:

```
STARTUP VG signed in as <username>
STARTUP LGL reached
STARTUP scheduler started write-vg=<on|off> write-lgl=<on|off> allow=<all|<n> ids|none> nightly=<HH:MM>Z
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
stopped and fails. A change check (step 6) running longer than
`CHECK_TIMEOUT_MINUTES` (default 5, at most 60) is stopped and fails. It writes to VG only when `WRITE_VG=true`; otherwise every pass is a
dry run. It writes to LGL only when `WRITE_LGL=true` as well, and only to the
constituents in `LGL_WRITE_ALLOW` (see "Writing to LGL"). Decisions files go to `OUT_DIR` (default `out`); those older than
`DECISIONS_KEEP_DAYS` (default 30) are deleted after each pass.

`SIGTERM` or `SIGINT` prints `STOPPING`, stops the running pass between
writes, prints `STOPPED` and exits 0.

## VG → Mailchimp audience

A second executable, `src/vg-mailchimp/main.js`, shares no code with the LGL
sync and ships in the same image. Each night it adds VG members, volunteers
and donors who are not yet in the Mailchimp audience, and archives contacts
that unsubscribed long ago. It never re-adds a contact whose status is
anything but absent. Both writes are off until `WRITE_MAILCHIMP_ADD` and
`WRITE_MAILCHIMP_ARCHIVE` are `true`. `npm run mailchimp` starts the service,
`npm run mailchimp-once` makes one dry run by hand, and
`npm run mailchimp-setup` prepares the service account. It has its own
`.env` and `out` directory (see `deploy/docker-compose.example.yml`). Every
command, setting, log line and the records format is in
[`docs/vg-mailchimp.1.md`](docs/vg-mailchimp.1.md).

## The image

The service ships as the Docker image `carlsmig/vg-sync`, built by
`.github/workflows/publish-docker.yml` on every push to `main` and tagged
`:<sha7>` and `:latest`. The image carries the commit in the
`org.opencontainers.image.revision` label and the `IMAGE_REVISION`
environment variable. It holds only `src/`, `package.json`, `policy.json` and
`policy-reconcile.json` (the go-live pass's rules, `docs/policy.json.5.md`);
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
no link (or holds it with a reason; staff can answer such a hold in VG with
"this is person X" or "a new person", and the next pass carries that out or
holds it as `resolution-failed`), removes the Donor mark from a person whose
LGL record is gone (or follows it to the record that replaced it), and prints a
summary followed by one line: `PASS OK full dry-run ...` or `PASS FAILED full
<reason>`. The line counts `links`, `creates` and `unlinks` beside the field
writes.

It is a dry run unless you add `--write-vg`. A dry run makes only read requests
to VG and none that change LGL. With `--write-vg` it records a run row in VG,
writes the planned changes, then the sync memory and holds, and closes the run
row. Nothing is written to LGL without `--write-lgl` (see "Writing to LGL").

- `npm run full -- --write-vg` writes to VG.
- `--write-lgl` (with `--write-vg`) also sends the planned LGL writes to the
  constituents in `LGL_WRITE_ALLOW`.
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
run would do to the hold table (opened, seen, reopened, closed, left dismissed,
and `refreshed`: detail replaced on a hold whose facts are unchanged, such as
the LGL name, email and address every unlinked donor's hold carries).

## Running a change check by hand

The service runs two light checks between the nightly passes; each can also be
run once by hand, dry unless `--write-vg` (and, for LGL, `--write-lgl`):

- `node src/lgl-vg/main.js --once vg-check [--write-vg] [--write-lgl] [--after <auditId>] [--out <dir>]`
  decides the people VG changed since the cursor. The cursor is `--after`, else
  the newest run row's `vgCursor`; with neither it exits 2 and says to give
  `--after`. It reads each touched constituent and its gifts from LGL.
- `node src/lgl-vg/main.js --once lgl-check [--write-vg] [--write-lgl] [--since <ISO time>] [--out <dir>]`
  decides the constituents and gifts LGL changed since the cursor (`--since`,
  else the newest run row's `lglCursor`). It first pulls every constituent and
  gift, as a full pass does, so it takes about as long as one.

Both print the counts and a `CHECK OK <kind> <dry-run|write-vg> ...` line (or
`CHECK OK <kind> <mode> no changes` when there is nothing to decide) and
exit 0, or print `CHECK FAILED <kind> <message>` and exit 1 at once (no
15-minute rule). `--snapshot` and `--max-people` are not accepted; the check
breaker uses `CIRCUIT_BREAKER_PEOPLE`.

## Writing to LGL

Writes to LGL are off by default, and need both switches and an allow-list:

- `--write-lgl` on `--once full`, `--once vg-check` and `--once lgl-check`, or
  `WRITE_LGL=true` for the service. `--write-lgl` requires `--write-vg`, and
  `WRITE_LGL=true` requires `WRITE_VG=true`: the log, the memory, the holds and
  the run row are all VG writes.
- `LGL_WRITE_ALLOW`: a comma-separated list of LGL constituent ids, or `all`.
  Empty or unset means none: with writing on and no allow-list, nothing is
  written to LGL.

A planned LGL write that is not sent is counted as `deferred` and shown, with
the calls it would make, in the decisions file: note `write-lgl off` without
the switch, `not-allowed` for a constituent not on the list. Every call sent is
logged in VG's `sync_log`. A person with an LGL write that will be sent counts
toward the circuit breakers; a deferred one does not. The run row's `switches`
record `writeLgl`, and its counts the LGL writes, stale fields and refusals.

`PASS OK` and `CHECK OK` end with `lgl-writes=<n> lgl-stale=<n>
lgl-refused=<n>`, after the keys above. On a dry run `lgl-writes` is the
number of writes a run with LGL writes on would send (the allow-list
applies), and the other two are 0.

A field written to LGL by more than three runs in thirty days is held
(`flapping`). The count is read from `sync_log`, in every mode, for the
people the guard looks up only (one read each, after a first plan); a run
with nothing to write to LGL reads no log. If one person's read reaches its
limit of 5000 rows the run fails without writing, since it cannot count.

### Go-live order

The engineer, 2026-11-19, after several rehearsals: the service comes up
with writes on in both systems at once. The staged LGL rollout planned on
2026-11-16 (LGL writes printed only, then a handful of donors, then the
backlog by hand) is dropped.

1. The service's deployment (VM, compose, alerts), and `seed-import
   --write-vg` into production VG.
2. Optional, read-only: `report --save-snapshot`, a copy of LGL before the
   first write.
3. Start the service with, in its `.env`:

   ```
   WRITE_VG=true
   WRITE_LGL=true
   LGL_WRITE_ALLOW=all
   POLICY_FILE=policy-reconcile.json
   CIRCUIT_BREAKER_PEOPLE=500
   ```

   The service runs a full pass at start. That pass is the backlog (a few
   hundred people) and the go-live reconciliation, so it needs the
   reconcile policy and a breaker above the default of 50, which would fail
   it without writing. 500 is a ceiling, not a target: more people than
   that means something is wrong.
4. After the first `PASS OK full`, remove `POLICY_FILE` and
   `CIRCUIT_BREAKER_PEOPLE` and restart. The checks between passes use the
   same settings until then, so do it promptly.
5. Point staff at VG's LGL sync screen.

## Rehearsing with a mock LGL

A rehearsal on production data (VG restored from a production dump) can
carry out its LGL writes and read them back on the next pass, without
touching LGL: set `LGL_MOCK` to a state file. Reads answer from the file;
`patchConstituent`, entry adds and entry patches change it (new entry ids,
one preferred entry per kind, an emptied addressee and salutation rebuilt
from the name) and stamp the constituent's `updated_at`, so the LGL check
and the next pass see the sync's own writes. The file is written back after
every write, so separate runs and the service see each other's writes.
`LGL_API_KEY` is not needed. Mock runs accept `--write-vg --write-lgl`.

It is a fetch stand-in behind the real LGL client (`src/lgl-vg/lgl-mock.js`),
so the request, paging and retry code is the code a real run uses. It does
not model LGL itself: no address verification, dedup, validation, refusals
or rate limits.

```sh
# Start (or reset) the state from a saved production pull. It holds real data: keep it in out/.
node src/lgl-vg/main.js report --save-snapshot          # writes out/lgl-snapshot-<time>.json
cp out/lgl-snapshot-<time>.json out/mock-lgl.json

LGL_MOCK=out/mock-lgl.json LGL_WRITE_ALLOW=all \
  node src/lgl-vg/main.js --once full --write-vg --write-lgl
```

A staff-style edit in LGL is an edit of the file: change the field and set
the constituent's `updated_at` to now (ISO, UTC), and the next LGL check
picks it up.

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
2. In VG, grant the Sync Service role (role 8) at federation level to the user
   name it printed.
3. Run `npm run setup -- --acknowledge-privacy`. This records the account's own
   acknowledgement of the current privacy rules, the only write `setup`
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
npm run harness -- [--only <name|area>] [--step N] [--overnight] [--resume] [--guards-only] [--seed-only]
```

- `--only` runs the named scenario or every scenario in an area (a file name
  under `harness/scenarios/`); it may be repeated. A value that matches
  nothing is an error.
- `--step N` is the build step (default 6): scenarios with a later `since`
  are skipped, and the runner says so.
- `--overnight` includes scenarios that wait for LGL's overnight jobs; the run
  stops at such a wait and saves its state.
- `--resume` continues a saved run from `out/harness-state.json` without
  reseeding.
- `--guards-only` checks that both targets are the test ones (local hosts, the dev stack's ports, never the demo stack) and stops.
- `--seed-only` sets up a starting point for running the service by hand:
  it reseeds, seeds the playground (`harness/playground.js`, a few invented
  people), or the starting records of the `--only` scenarios, runs one full
  pass that writes both sides so they are linked and agreeing, prints each
  LGL constituent id with its VG people, and stops. Then run the service
  against the same targets and make edits in the dev VG app or the LGL trial
  web app:

  ```
  WRITE_VG=true WRITE_LGL=true node src/lgl-vg/main.js --env .env.harness
  ```

  Stop the service before the next harness run, which wipes these records.

  Every reseed (a harness run or `--seed-only`) gives Admin to the dev login
  `HARNESS_VG_ADMIN_USER` (default `manual`), so the dev app can be used
  afterwards; it acknowledges the privacy rules at its first sign-in.

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
