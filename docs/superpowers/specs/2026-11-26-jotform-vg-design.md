# JotForm → VG: Friendly Calls & Visits reports

2026-11-26. The third executable in this repo, after LGL ↔ VG and
VG → Mailchimp. Board card VG-202611-528. This document covers the back end
only: the sync, the VG tables and the endpoints. The holds page in VG is
designed later, with the customer (see "Deferred").

## Intent

Volunteers report each friendly call or visit on a public JotForm form. The
customer's Friendly Calls & Visits lead reads the reports in JotForm and
in a spreadsheet. VG has a Friends feature built on `fcv_submission`, but
nothing has fed it since July 2026: an earlier prototype (branch `jot-sync`
in `ce-sheets-sync`) was paused on purpose.

The next VG cards (village Friends pages, village and staff summaries,
VG-202611-530 to 532) show these reports daily, so VG needs them within
minutes of submission. This service does that unattended.

**This sync is temporary.** The plan is to move the form into VG itself,
where volunteers sign in. Until then JotForm remains the form. Build for
correctness and simplicity, not for years of service: nothing here should
be hard to delete.

## Goals

- **Bring reports in.** A new or edited JotForm submission reaches VG
  within about 5 minutes. A submission deleted in JotForm is removed from
  VG by the next morning.
- **Match names.** Each report's free-text member and volunteer names are
  matched to VG people by fixed rules (below). Reports that cannot be
  matched, and reports with implausible dates, are held out of the reports
  until a person resolves them.
- **Remember answers.** When staff match a name by hand or mark it to
  ignore, the answer is stored. The same name resolves on its own from
  then on.
- **Reload at go-live.** Every existing `fcv_submission` row is replaced
  by the same submission read again through these rules, and rows whose
  submission JotForm no longer has are removed. Production Friends views
  are never empty along the way (see "Go-live reload").
- **Watch.** Deployed, monitored and alerted the way the other two
  executables are: heartbeat, failure lines, the generalized deployer, log
  shipping, Azure alerts.

## Non-goals

- **The holds page in VG.** The endpoints it needs are built here. The
  page waits for the customer (see "Deferred").
- **Any write to JotForm.** The form is not changed: no roster drop lists
  (dropped 2026-11-16, because a public form would expose the roster), no
  second village question. The service only reads.
- **Changing VG people.** Matching never edits a person's name, email or
  nickname.
- **Photos.** The form has an optional photo. None of the roughly 800
  submissions has one, the account requires a JotForm login to view
  uploads, and photos of members raise their own questions. Not read.
- **Who sees notes.** Restricting the Notes field to the village lead and
  the FC&V Coordinator role is VG-202611-530's job. This service stores
  notes as it receives them.
- **Backfill from before JotForm** (VG-202611-529).

## Anti-goals

- **Sending names outside our systems.** No AI or other third-party
  matching. The prototype sent the roster to an LLM. In the 245 reports it
  stored, 13 of the 17 cases where the matched member lived in a village
  other than the form's came through that fuzzy match, which suggests it
  guessed wrong.
- **Removing many reports after one bad read.** A full read that returns
  far fewer submissions than VG holds removes nothing.
- **A report counted under the wrong person.** When the rules are unsure,
  the report is held. A missing report can be fixed; a misattributed one
  goes unnoticed.
- **Real data in this repo or in Azure.** Shipped log lines carry counts
  only. Names stay in VG and on the VM.

## Constraints

- **Business rules are the customer's.** The implausible-date window, and
  whether an ignored name drops the whole report, are settings with safe
  defaults, listed under "Questions for the customer".
- **One repo, executables that share no code.** Code goes in
  `src/jotform-vg/`. Helpers are copied from `src/lgl-vg/` or
  `src/vg-mailchimp/`, not imported.
- **VG is reached only through its API,** as its own Keycloak
  service-account client, so every write lands in `audit_event`. Schema
  changes are app migrations in `~/dev/village-green`.
- **Node 24, no dependencies,** built-in `fetch`, as the other two.
- **Dry run by default.** Writes need an explicit switch, as in the other
  two executables.

### JotForm facts (verified 2026-11-26 against the live account, read-only)

- Silver plan. JotForm's support pages put Silver at 50,000 API calls a
  day, resetting at midnight US Eastern. This design uses a few hundred a
  day.
- Account time zone is America/New_York. Submission `created_at` and
  `updated_at` are local wall-clock strings (`YYYY-MM-DD HH:MM:SS`) with
  no offset.
- `GET /form/{id}/submissions` takes `limit` (up to 1000), `offset`,
  `orderby`, and a JSON `filter`. `{"updated_at:gt": "<time>"}` and
  `{"created_at:gt": "<time>"}` both work, to the second. `updated_at` is
  null on a never-edited submission. 22 of about 800 have been edited.
- Deleted submissions are not listed, including with a status filter. A
  deletion is only visible as an id that stopped appearing. VG holds 3
  reports whose submissions are gone from JotForm (all from May 2026), so
  deletions do happen.
- Listed submissions have status `ACTIVE` or `CUSTOM` (a status the form
  owner sets in JotForm's inbox). Both are real reports.
- The available API key reads. It got 403 listing webhooks. Writing is
  never needed.
- Questions on the form (by `qid`): 2 volunteer full name (first/last), 3
  member full name, 4 visit date, 5 time spent in minutes, 6 contact type
  (radio), 8 notes, 10 village (drop list), 13 "Monthly Reporting Tag"
  (date, optional), 21 activity types (checkboxes, with Other text), 22
  photo, 23 email address (optional; the volunteer's, per the customer on
  2026-11-23).

## Approaches

**Where it lives.** (1) A third executable in vg-sync, writing through the
VG API. (2) Its own repo, writing to the database, as the July prototype
planned. **Chosen by the engineer: (1).** It reuses deploy, alerts,
service-account and holds patterns, and keeps writes in the audit trail.
The cost is new API endpoints.

**Picking up changes.** (1) Full read every run. (2) A cursor on change
time every run, plus a full read nightly. (3) JotForm's webhook. **Chosen
by the engineer: (2).** (3) was rejected: it fires on new submissions
only (edits are unclear in JotForm's own answers; deletions are not
covered), delivery is not guaranteed, and it needs a public endpoint,
too much for a temporary sync. The nightly full read is what catches
deletions.

**Name matching.** (1) Rules only. (2) Rules, then an LLM for what's
left. **Chosen by the engineer: (1).** See "Anti-goals".

**Where holds and remembered answers live.** (A) New tables for this sync.
(B) Extend `sync_hold` with a source column. **Chosen by the engineer:
(A).** LGL holds are per person and field; these are per name with a
report count. Separate tables keep both shapes clean and let this one be
dropped when JotForm is retired.

**Holds page layout.** Deferred to the customer by the engineer. Two
mockups exist (`.superpowers/brainstorm/`, not committed): one shaped like
the LGL holds page, and one with a list of names and a pane showing the
reports.

## VG changes (app migration and API)

### Tables

`fcv_submission` (existing) gains:

| Column | Meaning |
|---|---|
| `jotformCreatedAt`, `jotformUpdatedAt` | JotForm's `created_at` and `updated_at`, as given (Eastern wall-clock, `datetime`). `updated_at` NULL if never edited. |
| `rawVolunteerName`, `rawMemberName` | Now always filled: the name as typed (`"First Last"`), whether or not matched. |
| `volunteerFirst`, `volunteerLast`, `memberFirst`, `memberLast` | The typed parts, kept separately so a held report can be re-matched from the stored row. |
| `volunteerEmail` | Question 23, as typed. |
| `reportingTag` | Question 13, `date`, as given. Its meaning is a question for the customer. |
| `volunteerMatch`, `memberMatch` | How the person was found: `remembered`, `email`, `name-village`, `name-elsewhere`, or NULL when not matched. `name-elsewhere` means the person is outside the form's village. |
| `held` | NULL when the report counts; otherwise why it does not: `name`, `date`, `ignored`, `unreadable`. |
| `dateDecision`, `dateDecidedAt`, `dateDecidedUserId` | Staff's answer on a questionable date: `accept` (the report counts) or `ignore` (it never counts). NULL until answered. The sync never writes these. |

`fuzzyVolunteerName` and `fuzzyMemberName` are dropped (prototype only).
Columns the sync may leave empty on an unreadable submission
(`visitDate`, `timeSpentMinutes`, `contactType`) become nullable. The
migration keeps existing rows (see "Go-live reload"). Releasing it is a
production change and needs the engineer's go-ahead.

`fcv_name_match` (new): the remembered answers.

| Column | Meaning |
|---|---|
| `role` | `member` or `volunteer`. |
| `nameKey` | The normalized name (see "Matching"). |
| `villageId` | The form's village; part of the key, since the same typed name in two villages can be two people. |
| `personId` | The person, or NULL with `ignore = 1`. |
| `ignore` | 1: reports with this name are junk and never count. |
| `createdAt`, `createdUserId` | Who answered, when. |

Primary key `(role, nameKey, villageId)`. Rows are written by the staff
resolution endpoint, never by the sync. A later answer for the same key
replaces the row, and the change is in `audit_event`.

`fcv_hold` (new): what the sync could not settle, one row per subject.

| Column | Meaning |
|---|---|
| `holdId` | Auto-increment. |
| `kind` | `name` (one per role + nameKey + villageId), `date` (one per submission), or `unreadable` (one per submission, for the engineer). |
| `role`, `nameKey`, `villageId`, `rawName` | For `name` holds. `rawName` is one typed spelling, for display. |
| `submissionId` | For `date` and `unreadable` holds. |
| `detail` | JSON. For a name hold: `candidates` (person ids, possibly empty), `reportCount`, `firstVisit`, `lastVisit`, `email` if one is on the reports. For a date hold: `visitDate`, `submittedAt`, `rule`. |
| `state` | `open` or `closed`. The sync closes a hold when its cause goes away (a resolution arrived, the report was edited or deleted). |
| `firstSeenAt`, `lastSeenAt`, `closedAt` | |

At most one open hold per subject: the `openKey` pattern from `sync_hold`
(a generated key that is NULL when closed, under a unique index). No
foreign keys, as for the other sync tables.

### Permissions and role

- A new federation role, **JotForm Sync** (next free `roleId`), for the
  service account. It needs: read persons, including members and
  volunteers who are no longer active, since old reports can name people
  since dropped; read villages; write `fcv_submission` and `fcv_hold`
  through the endpoints below; read `fcv_name_match`. Permission names
  follow the app's conventions (`docs` and `accessGates.js`), for example
  `friend-sync:write`.
- A staff permission to read holds and resolve them. Which role gets it
  is the engineer's call when the page is built; the Hub staff role that
  sees Friends today is the obvious one.

### Endpoints

Paths are a proposal; follow the app's OpenAPI conventions.

| Endpoint | Caller | Does |
|---|---|---|
| `GET /friends/sync/state` | sync | `{ cursor, count }`: the greatest of `jotformCreatedAt` and `jotformUpdatedAt` across all rows, and the row count. The cursor is derived from VG, not stored separately. |
| `GET /friends/sync/submissions` | sync | Every row's `id`, `jotformCreatedAt`, `jotformUpdatedAt`, typed names and parts, email, village, visit date, match columns, `held`, `dateDecision`. For the nightly compare and for re-matching without asking JotForm. |
| `PUT /friends/sync/submissions/{id}` | sync | Insert or replace one report (all columns above except `dateDecision*`, which it never touches). |
| `DELETE /friends/sync/submissions/{id}` | sync | Remove a report deleted in JotForm. |
| `GET /friends/sync/name-matches` | sync | All remembered answers. |
| `PUT /friends/sync/holds` | sync | Upsert open holds by subject and close the ones not in the body: the full set of open holds after a pass. |
| `GET /friends/sync/holds` | staff | Holds, with the persons named in `candidates` (as `/sync/holds` returns them). Filter by `state`. |
| `POST /friends/sync/holds/{holdId}/resolution` | staff | Name hold: `{ personId }` or `{ ignore: true }`, which writes `fcv_name_match`. Date hold: `{ accept: true }` or `{ ignore: true }`, which sets `dateDecision*` on the report. |

The Friends read (`FriendService.getFriends`) adds `fcv.held IS NULL`, so
held reports never reach any Friends view or download. The existing
rawName display path becomes unused but stays harmless.

## The sync (`src/jotform-vg/`)

### Runs

- **Change pass, every 5 minutes** (`CHANGE_EVERY`).
  1. `GET /friends/sync/state` for the cursor.
  2. Ask JotForm for submissions with `created_at:gt` and, separately,
     `updated_at:gt` *cursor minus `OVERLAP`* (default 2 hours: covers the
     repeated hour when clocks fall back, and a submission written near the
     boundary). Page with `offset` until a short page.
  3. Process each (below). Writes are idempotent, so the overlap only
     repeats work.
- **Full pass, nightly** (`FULL_AT`, default 03:00 Eastern), and once at
  service start.
  1. Read every submission from JotForm, paged.
  2. Read every VG row (`GET /friends/sync/submissions`).
  3. Process every JotForm submission that is new or whose
     `updated_at` differs.
  4. **Deletions:** a VG row whose id JotForm no longer lists is deleted,
     unless JotForm returned fewer than `MIN_FULL_SHARE` (default 0.9) of
     the VG row count, in which case the pass deletes nothing and logs
     `PASS FAILED` with the counts.
  5. Re-match from stored rows (below), and send the full set of open
     holds.
- **Re-matching from stored rows** (every pass, from
  `GET /friends/sync/submissions` and `GET /friends/sync/name-matches`,
  no JotForm call). **(call)**
  - Every held report is matched again, so a resolution takes effect
    within 5 minutes and a new VG person or nickname can clear a hold.
  - Every report whose name has a remembered answer gets that answer,
    whatever matched it before. A corrected answer (a later
    `fcv_name_match` row) therefore reaches reports that were already
    counting.
  - A report matched by email or name keeps its person until its
    submission is edited. A change in VG (a newcomer with the same name)
    does not pull a counting report back into the holds.
  - A row is written only if something changed.

### Processing one submission

1. **Read the answers** by `qid` (see "JotForm facts"). Names are
   `"First Last"` from the first/last parts, trimmed. Activity types map
   to the existing short codes (port the prototype's table, which keys
   on JotForm's exact option text, including its non-breaking spaces);
   the Other text goes to `activityOther`. Time spent must parse as a
   whole number ≥ 0; the visit date must parse. A submission that fails
   to parse is stored with `held = 'unreadable'` and an engineer hold.
2. **Village** by exact name against VG's villages (VG's name is
   "Aquidneck Island", as the form's is; the prototype's rename to
   "Aquidneck" is not ported). An unknown village is `unreadable`.
3. **Match the volunteer, then the member** (below).
4. **Check the date** (below).
5. `held` is set from the first that applies: `unreadable`, `ignored`
   (either name is remembered as ignore, or `dateDecision = 'ignore'`),
   `name` (either name is not matched), `date` (questionable with no
   decision). Otherwise NULL.
6. `PUT` the row.

### Matching

Each name is normalized to a **name key**: Unicode NFKD with accents
removed, lowercase, every run of characters other than letters replaced by
one space, trimmed. "  Jane  O'Doe-Smith " becomes `jane o doe smith`.

For a role (volunteer or member), in order; the first rule that gives
exactly one person wins:

1. **Remembered:** `fcv_name_match` for (role, key, form's village). An
   `ignore` answer stops matching for this report.
2. **Email** (volunteer only): the people whose VG email equals the
   report's (trimmed, lowercased) **and whose name matches** (below).
   Exactly one → matched. Otherwise this step does not decide and the name
   steps run. **(call)** VG emails are not unique (couples share one), and
   a volunteer may type a spouse's address. Requiring the name keeps the
   email from pointing at the wrong person.
3. **Name in the form's village:** among people in the form's village who
   hold that role (a member association for a member, a volunteer
   association for a volunteer; active or not), those whose name matches.
4. **Name elsewhere:** the same test over everyone in VG with that role.
   Exactly one → matched, `name-elsewhere` recorded.

A person's **name matches** the report's when, comparing keys:

- the report's last part equals the person's last name, and
- the report's first part equals the person's first name, or their VG
  nickname, or a name the nickname table pairs with it (Bill/William,
  Deb/Debra, and so on: a short table in this repo, invented examples
  only in tests); or
- the same with first and last swapped (a reversed entry).

At steps 3 and 4, two or more people → the next step is not tried: the name is held with those people as candidates. None
at a step → try the next. None at all → held with no candidates.

**Why the village is a preference, not a filter:** in the 245 reports
stored before July (checked 2026-11-26 against VG's people), 7 had a
volunteer from another village visiting a member in the form's village
(6 volunteers), and in 10 both people lived in the same other village,
which means the volunteer chose the wrong village on the form. A filter
would hold all 17. Some of those VG village values may also have changed
since spring.

### Dates

A report's date is **questionable** when the visit date is more than
`DATE_AHEAD_DAYS` (default 1) after the submission's `created_at` date, or
more than `DATE_BEHIND_DAYS` (default 90) before it. The defaults are the
engineer's; the window is the customer's to set. A date hold is cleared by
staff accepting it (`dateDecision = 'accept'`), by staff ignoring it
(`'ignore'`: the report gets `held = 'ignored'` and never counts), or by an
edit in JotForm that brings the date inside the window. A decision stays
with the report through later edits. **(call)**

### Holds

After each pass, the sync sends the complete set of open holds. A name hold
covers every report with that role, key and village; `detail.reportCount`
says how many. Holds no longer present (the reports were edited, deleted
or resolved) are closed by VG. The sync never resolves a hold itself.

### Logs and alerts

As in the other two executables: `SYNC ALIVE` heartbeat, one summary line
per pass with counts (fetched, inserted, updated, deleted, held by kind,
open holds), `PASS FAILED` on an exception or a refused deletion. No
names, emails or notes in log lines. A failed JotForm read (network, 5xx,
429) fails the pass; the next one retries. A 401 or 403 from JotForm or VG
ends the run, as `vg-mailchimp` does with Mailchimp.

### Settings

`.env`, as the others: VG API URL and Keycloak client, `JOTFORM_API_KEY`,
`JOTFORM_FORM_ID`, `WRITE` (off by default; off means the pass computes
everything and logs what it would write), `CHANGE_EVERY`, `FULL_AT`,
`OVERLAP`, `MIN_FULL_SHARE`, `DATE_AHEAD_DAYS`, `DATE_BEHIND_DAYS`. Plus
`--once change|full`, as `vg-mailchimp --once`.

### Deploy

Its own image (`vg-sync-jotform`), Dockerfile and CI workflow, built only
when its code changes, as `vg-mailchimp`. A `jotform` service in the
compose example, with its own `.env` and `out/` directory. The generalized
deployer, log shipping and an Azure heartbeat alert, copying the mailchimp
setup.

## Testing

- Unit tests for parsing (from invented submission fixtures shaped like the
  verified answers), name keys, each matching rule and its tie behavior,
  the date rule and the `held` precedence.
- A JotForm mock (as `lgl-mock.js`, `mailchimp-mock.js`) serving invented
  submissions, with edit and delete between runs, to test the cursor, the
  overlap, the nightly deletion and the deletion guard.
- A rehearsal against the local dev VG with its invented data, then a dry
  run against the real form and a restored production snapshot, reporting
  match rates by rule (counts only). The engineer expects 90% or more of
  reports to match unaided.

## Go-live reload

**(call)** The migration does not clear `fcv_submission`. The 245 rows
already there are keyed by JotForm submission id, as the new ones will be.
The first full pass with writes on treats every stored row as changed
(its `jotformUpdatedAt` is NULL and its match columns are empty), so it
replaces each one in place through the new rules, and deletes the rows
whose submission JotForm no longer lists (3 today, well inside the
deletion guard). Friends views show the old rows until then and the new
ones after, never nothing. Until the sync goes live, the old rows keep
showing, since their `held` is NULL.

Remembered answers do not exist at go-live, so names the prototype
matched by fuzzy guess will be held for the customer instead. That is
intended.

## Order

1. VG: migration, endpoints, role, the `held` filter in the Friends read.
   App tests. Release needs the engineer's go-ahead.
2. vg-sync: `src/jotform-vg/` with the mock, tests, dry run on dev.
3. Dry run against the real form and a production snapshot; review match
   rates and holds with the engineer.
4. Deploy to production with writes on (go-ahead), then the alert.
5. Later, after the customer picks a layout: the holds page.

The engineer wants something to show the customer on Monday 2026-11-30.
Until the holds page exists, held reports (perhaps 10%) are missing from
the Friends views.

## Questions for the customer

Settings with safe defaults until answered:

1. **Implausible dates.** Defaults: a visit more than a day after it was
   reported, or more than 90 days before. Is that right?
2. **"Monthly Reporting Tag"** (an optional date on the form): what is it
   for? Stored, not used.
3. **Junk names.** When a name is marked to ignore, the whole report is
   dropped. Is that right when the other name is real?
4. **A second Village question, for the volunteer.** Safe to add (only
   village names, no roster) and would help matching. The customer raised
   it on 2026-11-16 and 2026-11-23; it was set aside along with the name
   drop lists, not decided on its own. This design does not depend on it.
5. **The holds page:** which of the two layouts.

## Deferred

- The holds page (VG client), after question 5.
- Changing a remembered answer with no open hold behind it (a staff
  read/edit of `fcv_name_match`), and **changing or clearing a date
  decision** on a report. Once its hold closes, a resolution can no longer
  be changed through the API (409), so a wrong click is stuck until these
  endpoints exist. The sync already applies a changed answer to every
  report. Both endpoints **must ship with the holds page**, gated by
  `fcv_sync:resolve` and audited (independent review, 2026-11-26).
- **What staff need to see holds.** `GET /friends/sync/holds` is gated by
  `fcv_sync:read`, which also opens the sync's raw feed (every report
  federation-wide, with notes and emails) and the remembered answers.
  Decide when the page assigns staff permissions; for example, let
  `fcv_sync:resolve` alone read holds.
- **`submittedAt` time zone.** `GET /friends` declares `submittedAt` a UTC
  date-time, but the value is JotForm's Eastern wall-clock time, as the
  July prototype also stored it. Nothing reads it today; fix the label or
  the value when the village pages (VG-202611-530) show it.
- Using a volunteer-village question if one is added.
- Retiring this executable once the form moves into VG.

## Left to the builder

- Exact permission names, endpoint paths and response shapes, following
  the app's conventions.
- The nickname table's contents (common English nicknames; no real names
  in tests).
- Page size and paging details for the JotForm reads.
- How the sync reads people in bulk (`GET /persons?projection=detail`
  with inactive associations, as the other executables read them), and
  whether that read is cached between change passes.
