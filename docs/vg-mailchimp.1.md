# VG-MAILCHIMP(1)

## NAME

vg-mailchimp — add Village Green (VG) people to the Mailchimp audience and archive old unsubscribes

## SYNOPSIS

```
node src/vg-mailchimp/main.js [--env <file>]
node src/vg-mailchimp/main.js --once [--write-add] [--write-archive] [--max-add <n>] [--max-archive <n>] [--out <dir>] [--env <file>]
node src/vg-mailchimp/main.js setup  [--acknowledge-privacy] [--env <file>]
```

## DESCRIPTION

**vg-mailchimp** reads VG's persons through VG's API and builds a list of
addresses to mail. A person is in the *cohort* when they are not deceased and
are an active member, an active volunteer, or a donor. People who share an
address become one candidate. It then reads the Mailchimp audience, and:

- **archives** contacts whose status is `unsubscribed` and whose unsubscribe
  is at least `ARCHIVE_AFTER_DAYS` old, whether or not they are in VG;
- **adds** each candidate that is absent from the audience.

It never re-adds or resubscribes a contact whose status is anything but
absent (`unsubscribed`, `cleaned`, `pending`, `archived` and the rest are
recorded and left alone). It sends no tags, and it never deletes a contact
for good. It changes only the audience named by `MAILCHIMP_LIST_ID`, and
refuses to start if that audience's name is not `MAILCHIMP_LIST_NAME`.

A run is: read VG; read the audience; write an audience snapshot (when a
write switch is on); archive; re-read the billable count; classify; add;
report. A run fails closed: each write is read back, and counted only if it
took. 300 ms pass between Mailchimp writes.

## MODES

**The service** (no command). Signs in to VG, reaches Mailchimp, then runs
once at start and nightly at `MAILCHIMP_RUN_UTC`. A failed run is retried an
hour later, at most three times; a refused sign-in and a cohort below
`MIN_COHORT` are not retried. A run longer than `RUN_TIMEOUT_MINUTES` is
stopped and fails. A heartbeat line prints every five minutes. After each
run, records files older than `RECORDS_KEEP_DAYS` are deleted. It adds only
when `WRITE_MAILCHIMP_ADD=true` and archives only when
`WRITE_MAILCHIMP_ARCHIVE=true`.

**`--once`**. One run by hand. It ignores the `WRITE_MAILCHIMP_*` switches
and writes only with its own flags, so it is a dry run by default. Safe to
run beside the service only when dry.

**`setup`**. For a new service account: creates its user row, records its
privacy acknowledgement (only with `--acknowledge-privacy`), and checks that
it can read persons. On a 403 it prints which role to grant:
`<user> has no role grant. Grant it the Mailchimp Sync role at federation
level in VG, then run setup again.`

## OPTIONS

`--env <file>`
: Read variables from *file* (default `.env`). A variable already set in the
  environment wins.

`--write-add`, `--write-archive`
: (`--once`) Add, or archive, for real. Without them that part is counted only.

`--max-add <n>`, `--max-archive <n>`
: (`--once`) Override `MAX_ADD` and `MAX_ARCHIVE` for this run.

`--out <dir>`
: (`--once`) Write the records file and audience snapshot here instead of `OUT_DIR`.

`--acknowledge-privacy`
: (`setup`) Record the service account's privacy acknowledgement.

## ENVIRONMENT

Required: `MAILCHIMP_API_KEY` (unless `MAILCHIMP_MOCK` is set),
`MAILCHIMP_LIST_ID`, `MAILCHIMP_LIST_NAME` (unless `MAILCHIMP_MOCK` is set),
`VG_API_URL`, `VG_OIDC_URL`, `VG_CLIENT_ID`, `VG_CLIENT_SECRET`.

| Variable | Default | Meaning |
|---|---|---|
| `WRITE_MAILCHIMP_ADD` | `false` | `true`: the service adds contacts. |
| `WRITE_MAILCHIMP_ARCHIVE` | `false` | `true`: the service archives contacts. |
| `ARCHIVE_AFTER_DAYS` | 30 | An unsubscribed contact is archived once its unsubscribe is this old. |
| `PLAN_LIMIT` | 5000 | The plan's billable contact limit. |
| `LIMIT_MARGIN` | 100 | Room kept free below `PLAN_LIMIT`. Must be below it. |
| `MAX_ADD` | 50 | More adds than this in one run: none are made (`MAILCHIMP CAP`). |
| `MAX_ARCHIVE` | 50 | More archives than this in one run: none are made (`MAILCHIMP CAP`). |
| `MIN_COHORT` | 500 | A VG read with a smaller cohort fails the run before any Mailchimp request. |
| `MAILCHIMP_RUN_UTC` | `08:00` | Time of the nightly run (UTC). |
| `RUN_TIMEOUT_MINUTES` | 30 (max 1440) | A longer run is stopped and fails. |
| `RECORDS_KEEP_DAYS` | 30 | Older records files and snapshots are deleted after each run. |
| `OUT_DIR` | `out` | Records files and audience snapshots. |
| `VG_SCOPE` | `vg` | OAuth scope requested from VG's identity provider. |
| `MAILCHIMP_MOCK` | none | A state file that stands in for Mailchimp, for rehearsals: no request reaches Mailchimp, writes change the file, and the first line printed says so. |
| `IMAGE_REVISION` | none | The commit (set by the image). |

## OUTPUT

The service prints one line per event, each starting with its time (ISO,
UTC). Commands run by hand print without a time.

| Line | Meaning |
|---|---|
| `STARTUP VG signed in as <user>` / `STARTUP Mailchimp audience <name> reached` / `STARTUP scheduler started write-add=<on\|off> write-archive=<on\|off> nightly=<HH:MM>Z` | Start-up done. |
| `STARTUP FAILED <reason>` | Could not start (sign-in, audience not reached or wrongly named, configuration); exits 1. Alerted. |
| `MAILCHIMP OK adds=<n> archives=<n> subscribed=<n> left-out=<n> (no-email=<n> invalid-email=<n> unsubscribed=<n> cleaned=<n> archived=<n> limit=<n> cap=<n> other=<n>) billable=<n>/<limit> writes=<add:on\|off>,<archive:on\|off>` | A run finished. On a dry run, `adds` and `archives` are what a write run would do. |
| `MAILCHIMP FAILED <reason>` | A run failed. Alerted. |
| `MAILCHIMP LIMIT billable=<n> limit=<l> margin=<m> held=<k>` | The billing guard held back adds. Alerted. |
| `MAILCHIMP CAP add=<n> max=<m>` / `MAILCHIMP CAP archive=<n> max=<m>` | More than the cap: none made. Alerted. Clear by hand with `--once` and `--max-add` / `--max-archive`, after a reviewed dry run. |
| `MAILCHIMP ALIVE last=<time\|none> result=<ok\|failed\|running\|none> next=<time>` | Heartbeat, every five minutes. Alerted when absent. |
| `STOPPING` / `STOPPED` | Shutdown begun and finished. |

## FILES

`out/mailchimp-<runId>.jsonl`
: One JSON object per line, written once at the end of a run (also on
  failure or stop). `runId` is the run's start time (ISO, `:` and `.`
  replaced by `-`). It holds real addresses; never commit or share it.

| Field | Meaning |
|---|---|
| `kind` | `left-out`, `added`, `archived`, `archive-skipped` |
| `reason` | For `left-out`: `no-email`, `invalid-email`, `unsubscribed`, `cleaned`, `archived`, `limit`, `cap`, `write-unconfirmed`, or another Mailchimp status. For `archive-skipped`: the status found. |
| `personIds` | VG person ids behind the address (empty for an archive) |
| `email` | The address |
| `hash` | The subscriber hash (MD5 of the lowercased address) |
| `status` | The Mailchimp status read, when there is one |
| `at` | ISO time |

A person whose address is already subscribed gets no line.

`out/audience-<runId>.json`
: The audience as read before any write, written when a write switch is on.
  The restore reference for archives. Real data.

## EXIT STATUS

0
: The service stopped cleanly, or a `--once` run ended `ok`, or `setup` finished.

1
: Failure: a run failed or was stopped, start-up failed, or a configuration error.

2
: Usage error.

## SIGNALS

`SIGTERM`, `SIGINT`
: Stop the running job between writes, print `STOPPING` then `STOPPED`, and
  exit 0. A `--once` run stops the same way, saves its records, and exits 1.

## SAFETY

- Both write paths are off by default; `--once` writes only with its own flags.
- **Cohort floor**: a cohort under `MIN_COHORT`, or no persons, fails the run
  before any Mailchimp request.
- **Caps**: more than `MAX_ADD` adds or `MAX_ARCHIVE` archives in a run: none
  of that kind are made.
- **Billing guard**: adds stop at `PLAN_LIMIT` minus `LIMIT_MARGIN` minus the
  billable count (`member_count` + `unsubscribe_count`).
- **Re-read**: a contact is archived only if it still reads `unsubscribed`
  just before; every write is read back and counted only if it took.
- **Audience name**: start refuses if the audience's name is not
  `MAILCHIMP_LIST_NAME`.

## EXAMPLES

One dry run, reading what it would do:

```
node src/vg-mailchimp/main.js --once
```

Archive for real, after reviewing a dry run (raising the cap for this run):

```
node src/vg-mailchimp/main.js --once --write-archive --max-archive 120
```

Rehearse against a mock audience, with a state file `{ "list": { "id": "l1", "name": "" }, "members": [] }`:

```
MAILCHIMP_MOCK=out/mailchimp-mock.json node src/vg-mailchimp/main.js --once --write-add --env .env.harness
```

## SEE ALSO

vg-sync(1) (`docs/vg-sync.1.md`); `README.md`; the design,
`docs/superpowers/specs/2026-11-21-vg-mailchimp-design.md`;
`docs/mailchimp-findings-2026-11-11.md`.
