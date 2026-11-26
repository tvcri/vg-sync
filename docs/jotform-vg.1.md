# JOTFORM-VG(1)

## NAME

jotform-vg — copy the JotForm Friendly Calls & Visits reports into Village Green (VG)

## SYNOPSIS

```
node src/jotform-vg/main.js [--env <file>]
node src/jotform-vg/main.js --once change|full [--env <file>]
node src/jotform-vg/main.js setup [--acknowledge-privacy] [--env <file>]
```

## DESCRIPTION

**jotform-vg** reads the submissions of one JotForm form (the Friendly Calls &
Visits report) and writes them to VG through VG's API, where the Friends
pages count them. It only reads from JotForm. For each submission it reads the
answers, matches the volunteer's and the member's free-text names to VG people
by fixed rules, checks the visit date against a window, and stores the report
with a `held` reason when it cannot count yet (`name`, `date`, `ignored`,
`unreadable`). After each pass it sends the complete set of open holds, which
staff resolve in VG; the service never resolves one itself. Matching never
edits a person.

The sync is temporary: the form is to move into VG itself. The design is
`docs/superpowers/specs/2026-11-26-jotform-vg-design.md`.

JotForm times are America/New_York wall-clock strings
(`YYYY-MM-DD HH:MM:SS`). They are compared and stored as given, never
converted.

## MODES

**The service** (no command). Signs in to VG, reaches JotForm, then runs a
*full pass* at start and nightly at `FULL_RUN_UTC`, and a *change pass* every
`CHANGE_EVERY_MINUTES` after the first full pass succeeds. One pass runs at a
time. A failed full pass is retried an hour later, at most three times; a
failed change pass waits for its next turn. A pass longer than
`RUN_TIMEOUT_MINUTES` is stopped and fails. A 401 or 403 from VG or from
JotForm ends the service (exit 1). A heartbeat line prints every five minutes. It writes to VG
only when `WRITE_VG=true`.

A **change pass** asks JotForm for submissions created or updated after the
cursor held in VG, minus `OVERLAP_MINUTES`. A **full pass** reads every
submission, and also deletes the VG reports that JotForm no longer lists. If
JotForm returned too few of the stored reports (fewer than `MIN_FULL_PERCENT`
percent of them), it writes nothing and fails with
`full read returned <n> of <m> stored; nothing deleted`. If the read looks
whole but would still delete more than the rest of that share, it writes
nothing and fails with `full read would delete <n> of <m> stored; nothing
deleted`. See SAFETY for recovery.

**`--once change|full`**. One pass by hand, then exit. It is a dry run unless
`WRITE_VG=true`. Safe to run beside the service only when dry.

**`setup`**. For a new service account: creates its user row, records its
privacy acknowledgement (only with `--acknowledge-privacy`), checks that it
can read VG's Friends state, and reaches JotForm. On a 403 it prints which
role to grant: `<user> has no role grant. Grant it the JotForm Sync role (role
10) at federation level in VG, then run setup again.`

## OPTIONS

`--env <file>`
: Read variables from *file* (default `.env`). A variable already set in the
  environment wins.

`--acknowledge-privacy`
: (`setup`) Record the service account's privacy acknowledgement.

## ENVIRONMENT

Required: `JOTFORM_API_KEY` (unless `JOTFORM_MOCK` is set), `JOTFORM_FORM_ID`,
`VG_API_URL`, `VG_OIDC_URL`, `VG_CLIENT_ID`, `VG_CLIENT_SECRET`.

| Variable | Default | Meaning |
|---|---|---|
| `WRITE_VG` | `false` | `true`: passes write to VG. Otherwise they compute everything and count what they would write. |
| `CHANGE_EVERY_MINUTES` | 5 (max 1440) | Minutes from the end of one job to the next change pass. |
| `FULL_RUN_UTC` | `08:00` | Time of the nightly full pass (UTC; 03:00 Eastern in winter). |
| `OVERLAP_MINUTES` | 120 (at least 60) | A change pass reads from the cursor minus this. Covers the hour repeated when clocks fall back. |
| `MIN_FULL_PERCENT` | 90 (1 to 100) | A full read that would delete more than the rest of this share of the stored reports deletes none and fails. |
| `DATE_AHEAD_DAYS` | 1 | A visit date this many days after the report is questionable (held `date`). |
| `DATE_BEHIND_DAYS` | 90 | A visit date more than this many days before the report is questionable. |
| `RUN_TIMEOUT_MINUTES` | 30 (max 1440) | A longer pass is stopped and fails. |
| `VG_SCOPE` | `vg` | OAuth scope requested from VG's identity provider. |
| `JOTFORM_MOCK` | none | A state file that stands in for JotForm, for rehearsals: no request reaches JotForm and the first line printed says so. The service only reads it (a rehearsal edits it by hand between passes). The service writes no files; `out/` is used only to hold this file in mock rehearsals. Shape: `{ "form": { "status": "ENABLED" }, "submissions": [ … ] }`. |
| `IMAGE_REVISION` | none | The commit (set by the image). |

## OUTPUT

The service prints one line per event, each starting with its time (ISO,
UTC). Commands run by hand print without a time. Lines carry counts only: no
names, emails or notes.

| Line | Meaning |
|---|---|
| `JOTFORM DRY RUN: nothing is written to VG` | `WRITE_VG` is not `true`. Printed first. |
| `JOTFORM MOCK <file>: no request reaches JotForm; submissions are read from this file` | `JOTFORM_MOCK` is set. |
| `STARTUP VG signed in as <user>` / `STARTUP JotForm form reached` / `STARTUP scheduler started write-vg=<on\|off> full=<HH:MM>Z change-every=<n>m` | Start-up done. |
| `STARTUP FAILED <reason>` | Could not start (sign-in, JotForm not reached, configuration); exits 1. Alerted. |
| `JOTFORM OK <change\|full> fetched=<n> inserted=<n> updated=<n> unchanged=<n> deleted=<n> failed=<n> held_name=<n> held_date=<n> held_ignored=<n> held_unreadable=<n> open_holds=<n> wrote=<true\|false>` | A pass finished. On a dry run the counts are what a write pass would do. |
| `JOTFORM WARN <kind> failed=<n>` | A pass finished but VG refused <n> reports (kept as they were). Alerted. |
| `JOTFORM WARN form status is <status>, not ENABLED` | The form is not enabled; it may still hold reports. |
| `JOTFORM FAILED <kind>: <reason>` | A pass failed (read, VG, timeout, refused deletion: `full read returned <n> of <m> stored; nothing deleted` or `full read would delete <n> of <m> stored; nothing deleted`). Alerted. |
| `JOTFORM FAILED scheduler error` | An unexpected error in the scheduler. Alerted. |
| `JOTFORM ALIVE last=<time\|none> result=<ok\|failed\|none>` | Heartbeat, every five minutes. Alerted when absent. |
| `STOPPING` / `STOPPED` | Shutdown begun and finished. |
| `SETUP OK` / `SETUP FAILED: <reason>` | Result of `setup`. |

## EXIT STATUS

0
: The service stopped cleanly, or a `--once` pass ended `ok`, or `setup` finished.

1
: Failure: a pass failed or was stopped, start-up failed, a refused sign-in,
  or a configuration error.

2
: Usage error.

## SIGNALS

`SIGTERM`, `SIGINT`
: Stop the running pass at its next call, print `STOPPING` then `STOPPED`, and
  exit 0. A `--once` pass stops the same way and exits 1.

## SAFETY

- Nothing is written to VG unless `WRITE_VG=true`.
- The JotForm client has only GET: JotForm is never written.
- **Deletion guard**: a full read that returns too few of the stored reports,
  or that would delete more than the allowed share of them, writes nothing
  that pass (no rows, deletions or holds) and fails.
- A report VG refuses (400, 413 or 422) is counted in `failed` and keeps its
  stored state; its holds are kept. The pass goes on with the others.

**Recovering from a refused full pass.** A running service keeps its change
passes after a refused nightly full pass, but after any restart no change
pass runs until a full pass succeeds, so new reports stop reaching VG too.
To recover:

1. Check in JotForm whether the submissions were really deleted (compare the
   form's submission count with `<m>` and `<n>` from the FAILED line). If
   they were not, the read was short: look at JotForm, not the guard, and
   wait for the next full pass.
2. If they were deleted, stop the service.
3. Run one full pass with writes on and `MIN_FULL_PERCENT` lowered just
   enough to let the real deletions through: at most 100 minus the deleted
   share. For 45 of 300 stored deleted (15%), 85:
   `WRITE_VG=true MIN_FULL_PERCENT=85 node src/jotform-vg/main.js --once full`.
   On the VM, after `docker compose stop jotform`:
   `docker compose run --rm -e WRITE_VG=true -e MIN_FULL_PERCENT=85 jotform node src/jotform-vg/main.js --once full`.
   Expect `JOTFORM OK full … deleted=<n> wrote=true`.
4. Restart the service with the normal `MIN_FULL_PERCENT` (leave `.env`
   unchanged; the lowered value was for the one run).

## EXAMPLES

One dry run of a change pass:

```
node src/jotform-vg/main.js --once change
```

Rehearse a full pass against a mock form:

```
JOTFORM_MOCK=out/jotform-mock.json node src/jotform-vg/main.js --once full --env .env.jotform-dev
```

## SEE ALSO

`README.md`; the design,
`docs/superpowers/specs/2026-11-26-jotform-vg-design.md`; vg-mailchimp(1)
(`docs/vg-mailchimp.1.md`); vg-sync(1) (`docs/vg-sync.1.md`).
