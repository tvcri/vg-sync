# VG-SYNC(1)

## NAME

vg-sync — keep Little Green Light (LGL) and Village Green (VG) in step

## SYNOPSIS

```
node src/lgl-vg/main.js [--env <file>]
node src/lgl-vg/main.js --once full      [--write-vg [--write-lgl]] [--max-people <n>] [--snapshot <file>] [--out <dir>] [--env <file>]
node src/lgl-vg/main.js --once vg-check  [--write-vg [--write-lgl]] [--after <auditId>] [--out <dir>] [--env <file>]
node src/lgl-vg/main.js --once lgl-check [--write-vg [--write-lgl]] [--since <ISO time>] [--out <dir>] [--env <file>]
node src/lgl-vg/main.js report           [--save-snapshot] [--snapshot <file>] [--out <dir>] [--env <file>]
node src/lgl-vg/main.js seed-import --file <import-run.json> [--write-vg] [--env <file>]
node src/lgl-vg/main.js setup            [--acknowledge-privacy] [--env <file>]
```

## DESCRIPTION

**vg-sync** compares each VG person linked to an LGL constituent (a *linked
pair*), field by field, and copies a change from one system to the other as
`policy.json` directs. It links or creates a VG person for an LGL donor with
no link, removes the Donor mark from a person whose LGL record is gone, and
keeps the VG last gift date current. What it will not decide alone it
records as a *hold* in VG's `sync_hold` table, for staff.

Fields compared: first name, last name, suffix, nickname, address, email,
phones (home and cell), deceased.

The sync remembers the last value both systems agreed on (`sync_field`), so
it can tell which side changed:

| Case | Meaning |
|---|---|
| `same` | The two agree. |
| `first-match` | They agree, and nothing was remembered yet. |
| `converged` | Both changed, to the same value. |
| `lgl-changed`, `vg-changed` | One side changed since they last agreed. |
| `both-changed` | Both changed, differently. |
| `never-agreed` | They differ and have never agreed. |
| `lgl-cleared`, `vg-cleared` | One side emptied an agreed value. |

`policy.json` gives an action per field and case: `to-vg`, `to-lgl`, `hold`,
`merge` (phones), `toward-deceased`, or `to-lgl-else-hold` (email). Clearing
a value is always held. Couples (two VG people on one LGL record) hold their
first names, and hold shared fields when the partners disagree.

The sync never deletes a person in VG or a constituent in LGL, and never
creates a constituent in LGL. In LGL it adds, revives and retires entries
(marks them not current); it never deletes one.

## MODES

**The service** (no command). Signs in to VG, reaches LGL, then runs:

- a **full pass** at start and nightly at `FULL_PASS_UTC`. It reads every LGL
  constituent and gift and every VG person, memory row and hold. It is the
  only run that sees deletions and merges in LGL. A retryable failure is
  retried an hour later, at most three times.
- **ticks**, after the first successful full pass. Each tick runs the
  **VG check** (people changed in VG since its cursor). Every fifth tick,
  every fifteenth once neither check has found a change for an hour, the
  **LGL check** follows (constituents and gifts changed in LGL since its
  cursor). The next tick starts 60 seconds after a tick ends, so tick times
  drift and cannot be predicted from the start time.

One job runs at a time. A heartbeat line prints every five minutes, even
during a job.

**`--once full`**, **`--once vg-check`**, **`--once lgl-check`**. One run of
a full pass or a check, by hand. Dry unless `--write-vg`. Safe to run beside
the service: a writing run refuses, before writing, if another writing run is
in progress, and says which.

**`report`**. Reads both systems and prints counts; writes nothing.

**`seed-import`**. Loads the one-off import's decisions as holds, once,
before go-live, so the sync never undoes a staff decision. Dry unless
`--write-vg`. Running it twice adds nothing.

**`setup`**. For a freshly restored database: creates the service account's
user row and records its privacy acknowledgement.

## OPTIONS

`--env <file>`
: Read variables from *file* (default `.env`). A variable already set in the
  environment wins.

`--write-vg`
: Write to VG. Without it every run is a dry run: VG gets only reads, LGL none
  that change it.

`--write-lgl`
: Also send planned writes to LGL, for constituents in `LGL_WRITE_ALLOW`.
  Requires `--write-vg`. Not accepted by `seed-import`.

`--max-people <n>`
: Raise the circuit breaker to *n* people for this full pass.

`--snapshot <file>`
: Plan from a saved LGL snapshot; no LGL request. Not with `--write-vg`.

`--save-snapshot`
: (`report`) Save the LGL pull under the output directory.

`--after <auditId>`, `--since <ISO time>`
: Cursor for a VG or LGL check. Default: the newest run row's cursor.

`--out <dir>`
: Output directory (default `out`).

`--file <import-run.json>`
: (`seed-import`) The import's run file.

`--acknowledge-privacy`
: (`setup`) Record the service account's privacy acknowledgement.

## ENVIRONMENT

Required: `LGL_API_KEY`, `LGL_MEMBERSHIP_FUND_ID`,
`LGL_PAYPAL_PAYMENT_TYPE_ID`, `VG_API_URL`, `VG_OIDC_URL`, `VG_CLIENT_ID`,
`VG_CLIENT_SECRET`.

| Variable | Default | Meaning |
|---|---|---|
| `WRITE_VG` | off | `true`: the service writes to VG. |
| `WRITE_LGL` | off | `true`: the service writes to LGL. Requires `WRITE_VG=true`. |
| `LGL_WRITE_ALLOW` | none | Constituent ids (comma-separated) or `all` that LGL writes may reach. |
| `VG_SCOPE` | `vg` | OAuth scope requested from VG's identity provider. |
| `FULL_PASS_UTC` | `07:00` | Time of the nightly full pass (UTC). |
| `CIRCUIT_BREAKER_PEOPLE` | 50 | A write run that would change more people stops without writing. Checks count 24 hours together. |
| `MAX_CONSTITUENT_DROP_PERCENT` | 10 | A full pass stops if LGL returns this much smaller a count than the last good pass. |
| `CREATE_HORIZON_YEARS` | 5 | An unlinked donor whose last gift is older is not created in VG. |
| `PASS_TIMEOUT_MINUTES` | 30 (max 1440) | A longer full pass is stopped and fails. |
| `CHECK_TIMEOUT_MINUTES` | 5 (max 60) | A longer check is stopped and fails. |
| `POLICY_FILE` | `policy.json` | The rules file. |
| `OUT_DIR` | `out` | Decisions files. |
| `DECISIONS_KEEP_DAYS` | 30 | Older decisions files are deleted after each pass. |
| `IMAGE_REVISION` | none | The commit, recorded on each run row (set by the image). |

## OUTPUT

The service prints one line per event, each starting with its time (ISO,
UTC). Commands run by hand print without a time, and `--once` prints a JSON
summary before its final line.

| Line | Meaning |
|---|---|
| `STARTUP VG signed in as <user>` / `STARTUP LGL reached` / `STARTUP scheduler started ...` | Start-up done; the last line shows the switches, allow-list and nightly time. |
| `STARTUP FAILED <reason>` | Could not start; exits 1. Alerted. |
| `PASS OK full <mode> people=<n> writes=<n> ...` | A full pass finished. |
| `PASS FAILED <kind> <reason>` | A full pass failed, or a check kept failing for 15 minutes (repeated hourly). Alerted. |
| `PASS STOPPED full <reason>` | A pass ended by shutdown. |
| `CHECK OK <kind> <mode> ...` | A check found and decided something. A check that finds nothing prints nothing. |
| `CHECK FAILED <kind> <reason>` | One check failed. |
| `CHECK RECOVERED <kind>` | Checks succeed again after a `PASS FAILED`. |
| `CHECK STOPPED <kind> <reason>` | A check ended by shutdown. |
| `SYNC ALIVE last-full=... result=... next-full=... last-vg-check=... last-lgl-check=... lgl-every=<5m\|15m>` | Heartbeat, every five minutes. Alerted when absent. |
| `STOPPING` / `STOPPED` | Shutdown begun and finished. |

Counts on `PASS OK` and `CHECK OK`: `people` changed, VG `writes`,
`deferred` (planned but not sent), `links`, `creates`, `unlinks`,
`holdsOpened`, `holdsClosed`, `holdsOpen`, and `lgl-writes`, `lgl-stale`,
`lgl-refused`. On a dry run the counts are what a write run would do.

## FILES

`out/full-<time>.jsonl`, `out/checks-<YYYY-MM-DD>.jsonl`
: One decision per line: person, constituent, field, case, action, outcome,
  both values, and the LGL calls a write makes. They contain real people;
  never commit or share them.

`policy.json`
: The customer's rules: an action per field and case, record rules, settings
  (`couple-lgl-changed`, `lgl-addressee`).

VG tables written (through VG's API): `sync_field` (agreed values),
`sync_hold` (holds), `sync_run` (one row per write run, with counts and
cursors), `sync_log` (one row per LGL call sent).

## EXIT STATUS

0
: Success, or the service stopped cleanly.

1
: Failure: a pass or check failed, start-up failed, or a configuration error.

2
: Usage error, or a check with no cursor.

## SIGNALS

`SIGTERM`, `SIGINT`
: Stop the running job between writes, print `STOPPING` then `STOPPED`, and
  exit 0. A signal during start-up stops at once.

## SAFETY

- Every write path is dry by default.
- **Circuit breaker**: a run that would change more people than the limit
  writes nothing.
- **Constituent drop**: a full pass that reads far fewer LGL records than the
  last one writes nothing.
- **Stale check**: each write is checked against a fresh read just before it
  is sent; a value that moved since the plan is skipped (`stale`).
- **Flapping**: a field written to LGL by more than 3 runs in 30 days is held.
- **Refusals**: a write VG or LGL refuses opens a hold and is not retried
  until the value changes.

## EXAMPLES

Run one dry full pass and read what it would do:

```
node src/lgl-vg/main.js --once full
```

Run the service against the test targets, writing to both:

```
WRITE_VG=true WRITE_LGL=true node src/lgl-vg/main.js --env .env.harness
```

Force a full pass while the service runs, from a second terminal:

```
node src/lgl-vg/main.js --once full --write-vg --write-lgl --env .env.harness
```

## SEE ALSO

`README.md`; the sync design,
`docs/superpowers/specs/2026-11-11-lgl-vg-sync-design.md`; LGL writes,
`docs/superpowers/specs/2026-11-16-lgl-vg-step7-lgl-writes-design.md`;
`docs/handoff-2026-11-16-go-live.md`; `docs/handoff-2026-11-17-holds-ui.md`.
