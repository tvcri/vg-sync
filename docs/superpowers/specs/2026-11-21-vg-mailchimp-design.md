# VG → Mailchimp: the audience service

2026-11-21. The second executable in this repo, after LGL ↔ VG. It replaces
the hand-run `sync-vg-to-mailchimp.mjs` and `archive-unsubscribed.mjs` in
`~/dev/tvcri/mailchimp-poc`. Read `docs/mailchimp-findings-2026-11-11.md`
first: its API facts are relied on here and not repeated.

## Intent

The engineer has kept the customer's Mailchimp audience complete by hand:
every active member, active volunteer and living donor in VG is a contact,
so new people get the newsletter. This service does that unattended, every
night, on the production VM.

The customer's executive director also asked for unsubscribed contacts to be
archived regularly. She was surprised to learn that unsubscribed contacts
count toward the plan's billable limit, and archived ones do not. The
service does that too.

Tags are not part of this. A tag service may come later. The newsletter
goes to the whole audience, so getting people onto the list is what
matters now.

## Goals

- **Add.** Each night, every person in the cohort (below) who has an
  address and is absent from the audience is added as a subscribed
  contact, with first and last name.
- **Archive.** Each night, every contact unsubscribed for at least
  `ARCHIVE_AFTER_DAYS` (default 30) is archived.
- **Record.** Each cohort person the service did not add, each contact it
  added, and each contact it archived is recorded with a reason, in a file
  that stays on the VM. A later review screen will be built on these
  records (see "Records").
- **Watch.** The service is deployed, monitored and alerted the way vg-sync
  is: heartbeat, failure lines, the generalized deployer, log shipping and
  Azure alerts.

## Non-goals

- Tags: writing, removing or reading them for any decision. No `tags` key
  is ever sent.
- Updating a contact's name or address. When a person's email changes in
  VG, their old contact stays subscribed (findings, "When an email changes
  in VG"). Fixing that needs a VG person ↔ contact link that nothing records
  today.
- The review screen, and any VG table or endpoint for these records.
- Reporting bad addresses to staff. They are recorded, not reported.
- Writing anything to VG.

## Anti-goals

- **Re-adding anyone who opted out.** Unsubscribed, cleaned (bounced) and
  archived contacts are never re-added or resubscribed, by any path.
- **Deleting a contact.** Archive is `DELETE /lists/{id}/members/{hash}`.
  Permanent delete erases the suppression record; the string
  `delete-permanent` must not appear in this executable's code.
- **Going over the plan's billable limit** because nobody was watching.
- **Archiving a large share of the audience** after one bad read.
- **Writing to the second audience** in the account (the outside
  designer's), even for testing.
- **Real data in Azure or in this repo.** Per-person records stay on the
  VM; shipped log lines carry counts only.
- **Making staff work** that routes through the engineer.

## Constraints

- **Business rules are the customer's.** Who is mailed, how long before
  an unsubscribed contact is archived, how close to the limit to stop:
  each is a setting with a safe default, listed under "Settings".
- **One repo, two executables that share no code** (brief, 2026-11-11).
  Code is ported into `src/vg-mailchimp/`, not imported from
  `src/lgl-vg/`. Copying a helper is fine.
- **VG is read through its API**, as vg-sync does, not its database.
  `GET /persons` returns summary rows (`PersonService.getPersons`, verified
  in the app code 2026-11-21) with `personId`, `fullName`, `deceased`,
  `email`, `memberStatus`, `volunteerStatus` and, with `donor:read`,
  `donor`. The statuses come from the `active_member` and `active_volunteer`
  views, unless the caller holds `member:read_inactive` or
  `volunteer:read_inactive`, when they come from the base tables and a
  dropped record reads `Dropped`. So the cohort tests `=== 'Active'`, never
  "not null". First and last name need `projection=detail`, as vg-sync
  reads it. The service checks for the `donor` key, as vg-sync does, and
  fails the run if it is missing.
- Mailchimp: Essentials plan, 5,000 billable contacts; billable =
  `stats.member_count + stats.unsubscribe_count`. Merge fields are only
  `FNAME` and `LNAME`, required; organizations (blank names) are written
  with `skip_merge_validation=true`.
- No dependencies: Node 24, built-in `fetch`, as vg-sync.

## Approaches

**Where per-person records live.** (1) Log lines now, with a VG table
when the review screen is built. (2) A VG table and endpoints now (a
sibling of `sync_hold`, or `sync_hold` with a source column), written from
day one. **Chosen by the engineer: (1).** The list of people left out is
recalculated each night from live data, so a screen needs only tonight's
list, not history. Building the table when the screen is built loses
nothing, and its shape can follow the screen's needs. (2) would need an app
migration and release before go-live and would fix the table's shape early.
Refinement after the choice: the per-person records go in a file on the VM
rather than in shipped log lines, because vg-sync keeps real data out of
Azure (step 5 design, "Decisions files"). **(call)**

**How VG is read.** API (as vg-sync) or direct database read (as the
hand-run job and the email sidecar). **API, engineer's call.** The fields
are already there, and it keeps database credentials out of one more
container.

**Archiving in this job or a separate one.** Same account, same
credentials, same nightly run, a separate write switch. **In this job,
agreed with the engineer.**

## The cohort

Ported from `mailchimp-poc/sync/vg-source.mjs`, read through the API:

- A person is in the cohort when they are not deceased and are an active
  member, an active volunteer, or a donor (any VG donor association; no
  last-gift cutoff). Same rule as the hand-run job.
- The address is `email`, trimmed and lowercased. A person with no address
  is recorded `no-email`.
- **Invalid syntax** (no `@`, no dot in the domain, whitespace inside):
  recorded `invalid-email` and not sent. A plausible domain misspelling is
  not detected or corrected. Correcting addresses is not the engineer's call.
- **One candidate per address.** People who share an address (couples)
  become one candidate. The name comes from the lowest person id among
  them. **(call: the hand-run job used "first returned", which is not
  stable across runs)** Each person who shares the address is recorded.
- `person.emailStatus` is not read (findings).

## A run

One run, nightly. The steps happen in this order, so archiving frees room
before anything is added.

1. **Read VG.** Sign in, read persons, build the candidate list. A read
   that returns zero persons, or a cohort under `MIN_COHORT` (default
   500), fails the run before any write. **(call)** The cohort was about
   1,730 people in November.
2. **Read the audience.** One pass over `/lists/{id}/members` (all
   statuses except archived, which the API does not list), and
   `GET /lists/{id}` for the counts.
3. **Snapshot.** If either write switch is on, write the audience pass
   to `OUT_DIR/audience-<date>.json` before any write. This is the restore
   reference for archives. **(call)**
4. **Archive.** Candidates are contacts with status `unsubscribed` whose
   unsubscribe is at least `ARCHIVE_AFTER_DAYS` old. The date used is
   `last_changed`. **The builder verifies on the live account** (a read)
   that `last_changed` on unsubscribed contacts tracks the unsubscribe,
   and uses the member activity feed instead if it does not.
   - If there are more than `MAX_ARCHIVE` (default 50) candidates, archive
     none and print `MAILCHIMP CAP archive=<n> max=<m>`. **(call)** The
     first production run will trip this (about 100 have built up since
     July). The engineer clears it by hand, with an override (see
     "Commands").
   - Before each archive, re-read the contact's status. Archive only if it
     is still `unsubscribed`. After the write, read the status back, and
     count the archive only if it reads `archived`.
   - Archiving does not depend on the cohort. Any unsubscribed contact
     qualifies, in VG or not.
5. **Classify** each candidate address against the audience, fail-closed,
   ported from `sync/classify.mjs`:
   - `subscribed`: nothing to do (not recorded per person, counted).
   - `unsubscribed`, `cleaned`, `pending`, `transactional`, or any other
     status: recorded with that status as the reason, not touched.
   - Absent from the pass: look up by hash (`GET .../members/{hash}`).
     `archived` is recorded `archived`. Not found means a candidate to add.
     Any other answer is recorded with its status.
6. **Add**, if the add switch is on.
   - **Billing guard.** Room = `PLAN_LIMIT` − `LIMIT_MARGIN` − billable
     (billable is re-read after archiving). If there are more adds than
     room, add the first ones in person-id order up to the room, record
     the rest as `limit`, and print `MAILCHIMP LIMIT billable=<n>
     limit=<l> margin=<m> held=<k>`. **(call)**
   - **Add cap**, counted after the billing guard. More than `MAX_ADD`
     (default 50) adds in one night:
     add none and print `MAILCHIMP CAP add=<n> max=<m>`. **(call)** A
     normal night adds a handful. A sudden jump means something is wrong
     upstream.
   - Each add is `PUT /lists/{id}/members/{hash}` with
     `status_if_new: "subscribed"`, the merge fields, and
     `skip_merge_validation=true`. After each write, read the contact back.
     It counts as added only if it reads `subscribed`. Anything else is
     recorded `write-unconfirmed` with the status read.
   - 300 ms between writes (findings).
7. **Report.** One shipped summary line (below), and the records file.

**Dry run** (both switches off, the default): steps 1, 2, 4 (counting
only), 5, 6 (counting and the guard, no writes), 7. A dry run still
records reasons, and still prints `MAILCHIMP LIMIT` and `MAILCHIMP CAP`,
so they can be seen before writes are switched on.

## Records

`OUT_DIR/mailchimp-<runId>.jsonl`, where `runId` is the run's start time
(ISO, with `:` and `.` replaced by `-`), one JSON object per line. Records
and audience snapshots are kept `RECORDS_KEEP_DAYS` (default 30). These hold real data and are not
shipped.

| Field | |
|---|---|
| `kind` | `left-out`, `added`, `archived`, `archive-skipped` |
| `reason` | for `left-out`: `no-email`, `invalid-email`, `unsubscribed`, `cleaned`, `archived`, `limit`, `cap`, `write-unconfirmed`, or another Mailchimp status; for `archive-skipped`: the status found |
| `personIds` | VG person ids behind the address (empty for an archive) |
| `email` | the address |
| `hash` | the subscriber hash |
| `status` | the Mailchimp status read, when there is one |
| `at` | ISO time |

Persons whose address is already subscribed get no line.

The reason codes are the stable part. When the review screen is built, the
same objects become rows in a VG table, with a state and a dismissal like
`sync_hold`.

## Commands and configuration

`node src/vg-mailchimp/main.js`, no command: the service. It signs in,
prints `STARTUP` markers, starts its scheduler, and runs once at start and
then nightly at `MAILCHIMP_RUN_UTC`.

`--once` runs one run and exits. Flags for a by-hand run:
`--write-add`, `--write-archive`, `--max-add N` and `--max-archive N` (the
cap overrides). The first production archive runs this way, with the
engineer's go-ahead after a reviewed dry run.

### Settings

Environment, with the default. The **customer** column marks the
settings that are business rules.

| Setting | Default | Customer |
|---|---|---|
| `WRITE_MAILCHIMP_ADD` | `false` | |
| `WRITE_MAILCHIMP_ARCHIVE` | `false` | |
| `ARCHIVE_AFTER_DAYS` | `30` | yes |
| `PLAN_LIMIT` | `5000` | yes (it follows the plan) |
| `LIMIT_MARGIN` | `100` | yes |
| `MAX_ADD` | `50` | |
| `MAX_ARCHIVE` | `50` | |
| `MIN_COHORT` | `500` | |
| `MAILCHIMP_RUN_UTC` | `08:00` (an hour after vg-sync's `07:00`) | |
| `RUN_TIMEOUT_MINUTES` | `30` | |
| `RECORDS_KEEP_DAYS` | `30` | |
| `OUT_DIR` | `out` | |
| `MAILCHIMP_API_KEY`, `MAILCHIMP_LIST_ID` | none; start fails without them | |
| VG and Keycloak settings | as vg-sync's | |

A start refuses if `MAILCHIMP_LIST_ID` is not found, or if its name
differs from `MAILCHIMP_LIST_NAME`. This guards against pointing at the
designer's audience. **(call)**

The cohort rule (members, volunteers, donors) is fixed in code, as in the
hand-run job. It becomes a setting only if the customer asks to change it.

## The scheduler, log lines, failure

Modeled on `src/lgl-vg/scheduler.js` (copied, not imported). Strings
differ so that each alert matches one service:

- `MAILCHIMP ALIVE last=<time|none> result=<ok|failed|running|none>
  next=<time>` every five minutes.
- `MAILCHIMP OK adds=<n> archives=<n> subscribed=<n> left-out=<n>
  (no-email=<n> invalid-email=<n> unsubscribed=<n> cleaned=<n>
  archived=<n> limit=<n> cap=<n> other=<n>) billable=<n>/<limit>
  writes=<add:on|off>,<archive:on|off>`.
- `MAILCHIMP FAILED <reason>`, `MAILCHIMP LIMIT ...`, `MAILCHIMP CAP ...`,
  `STARTUP ...`, `STOPPING`, `STOPPED`.
- A failed run is retried an hour later, up to three times, then waits for
  the next night. A refused sign-in (Keycloak 401, Mailchimp 401) and a
  `MIN_COHORT` failure are not retried. **(call, as vg-sync)**
- `SIGTERM` stops between writes, never during one.
- Every Mailchimp and VG request has a timeout. A 429 or 5xx is retried
  with backoff a few times before the run fails.

## Deploy and monitoring

- **Image.** The repo's one image, `carlsmig/vg-sync`, gains
  `src/vg-mailchimp/`. The compose file gets a second service, `mailchimp`,
  with `command: node src/vg-mailchimp/main.js`, its own `.env` and its own
  `out` mount. **(call)** One image keeps CI as it is. The cost is that a
  Mailchimp-only change also redeploys the LGL sync, which then runs a full
  pass at start. That is harmless by design.
- **Deployer** (`vg-utils/vm-sidecar-deploy`). Add a `mailchimp` row:
  repository `carlsmig/vg-sync`, its `STARTUP` markers, failure pattern
  `STARTUP FAILED|MAILCHIMP FAILED`, pin not required. Check that two
  services pinned to the same repository both get rewritten.
- **Log shipping** (`vg-utils/vm-logship`). Add `tvcri-mailchimp-1` to
  `CONTAINERS`.
- **Alerts** (`alerts-sync.sh` or a sibling). `vg-mailchimp-failed` on
  `MAILCHIMP FAILED`, `STARTUP FAILED`, `MAILCHIMP LIMIT` and
  `MAILCHIMP CAP`. `vg-mailchimp-silent` on fewer than one
  `MAILCHIMP ALIVE` in 15 minutes. Created disabled. Creating them needs
  the engineer's go-ahead.
- **VG access: its own service account (engineer, 2026-11-21).** A new
  Keycloak client (for example `vg-mailchimp`), created by the engineer, and
  a new federation-scope VG role that can read persons and donors and
  nothing else. Roles are created by app migrations in VG (the Sync Service
  role came from `0033-sync.js`), so this is a village-green migration and
  release, and it must ship before the service is deployed, even with writes
  off. The role needs whatever `GET /persons` with `donor` requires
  (`person:read` and `donor:read` at federation level, to be confirmed in
  the app). It does not get `member:read_inactive` or
  `volunteer:read_inactive`, so the statuses come from the active views.
  The account also needs the privacy acknowledgement vg-sync's setup
  performs. Setup prints the role to grant when the account has none, as
  vg-sync's does.

## Testing and rehearsal

- **Unit tests** (`node --test`, as the repo): cohort building and
  deduplication, address syntax, classification, the archive age test,
  the billing guard, both caps, `MIN_COHORT`, read-back handling (a 200
  that did not take), the scheduler, and the summary line.
- **A Mailchimp mock**, `MAILCHIMP_MOCK=<state file>`, modeled on
  `LGL_MOCK`. It simulates an audience with all five statuses, PUT
  behaving as the findings describe (including PUT on an archived contact
  returning 200 and doing nothing), DELETE as archive, and the counts.
  Write runs are rehearsed against it with the local dev VG.
- **Real-data dry run.** Restore a production snapshot to the local dev
  VG (`vg-utils/mysql-dump`), point the service at the production audience
  with both switches off, and compare its numbers with the hand-run
  `sync-vg-to-mailchimp.mjs` dry run against the same snapshot. Reads only,
  but it reads production Mailchimp, so each run needs the engineer's
  go-ahead (repo `CLAUDE.md`). The `last_changed` check in "A run" step 4
  is the same kind of read.
- No scratch Mailchimp audience is needed. If one is used, it must be one
  the engineer creates, never the designer's.

## Go-live

0. The village-green release with the new role is in production; the
   engineer has created the Keycloak client and granted the role.
1. Deploy with both switches off. Watch a night's dry run in the logs.
2. With the engineer's go-ahead: a by-hand `--once --write-archive
   --max-archive <reviewed count>` to clear the backlog, then
   `--write-add` the same way.
3. Switch both on in `.env`, restart, and enable the alerts.

Every production Mailchimp write before step 3 is a by-hand run with the
engineer's explicit go-ahead.

## For the customer (a short list, with defaults in place)

- How long after unsubscribing a contact is archived. Default 30 days.
- How close to the plan limit to stop adding, and who is told. Default
  100 contacts below the limit; the alert goes to the engineer.
- Whether the left-out list (no address, bad address, bounced) should
  reach staff, and as what. Today it is kept on the server only.

## Left to the builder

- The role's id, name and exact permission list, in the village-green
  migration (board item and app conventions per its `CLAUDE.md`).
- The exact module layout under `src/vg-mailchimp/`, and what to copy
  from `src/lgl-vg/` (Keycloak sign-in, scheduler, VG client).
- Verifying `last_changed` as the unsubscribe date (step 4).
- Pagination and field selection for the audience pass (`paginate()` in
  `mailchimp-poc/mailchimp.mjs`).
- Backoff numbers.
- The `docs/vg-mailchimp.1.md` manual page, matching `docs/vg-sync.1.md`.
