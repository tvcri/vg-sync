# LGL ↔ VG sync: design

2026-11-11. Status: draft for the engineer's review. Nothing is built
beyond three throwaway test scripts in `spike/`.

This is the design for the first of the two executables in this repo. It
builds on `docs/context-2026-11-11.md` (the brief), which records what was
already decided and why; this document does not repeat that reasoning. Where
this design makes a new engineering call, it is marked **(call)**. Where it
found the brief to be wrong or incomplete, it says so under "What was
verified".

## Intent

Staff edit donors in both Little Green Light (LGL) and Village Green (VG).
Every few minutes, with nobody watching, the service makes each system
catch up with edits made in the other, links or creates VG people for new
LGL donors, and keeps VG's last gift date current. A nightly full comparison
catches anything missed. Anything it is not sure about, or
that the customer has not ruled on, it leaves alone and records.

## Goals

- A change to a linked donor's name, address, email, phone or deceased state
  in one system reaches the other within minutes, wherever the policy file
  allows the copy.
- A new LGL donor becomes a VG person, or is linked to the existing one.
- VG's last gift date follows LGL.
- Every business rule is a row of configuration with "do nothing and record
  it" as the default.
- Every write to VG appears in `audit_event` under the service's own
  identity. Every write to LGL is recorded in VG, because nothing else
  records it.
- A check or pass that goes wrong stops early and raises an alert, and
  repeating it is always safe.

## Non-goals

- Mailchimp. That is the second executable, designed later.
- Organizations, until VG has a model for them.
- Dues-only members. They have no link and are not touched.
- Gift history in VG.
- A screen or worklist for staff. Items the service leaves alone are
  queryable in the VG database and counted in each full pass's summary. A staff
  view of them is a likely follow-up and is not part of this work. Sending
  those items to staff is in scope; see "Telling staff".
- Legislative districts. They are not on the app's `main` branch.
- Carrying LGL's verified ZIP+4 form of an address into VG.

## Anti-goals

These would make the service a failure even if it runs without error:

- A duplicate person in VG.
- Linking two different people (the lesson of the false deceased flag).
- Creating or deleting a constituent in LGL, or deleting a person in VG.
- Overwriting a deliberate value with a stale one, in either direction.
- Undoing a decision staff made in the import review.
- Copying a malformed LGL value into VG, where it would print on an envelope.

## What was verified

Checked against the live LGL account on 2026-11-11. The write tests used one
invented constituent, created for the test and deleted afterward. The
scripts are in `spike/`.

| Question | Result |
|---|---|
| Does the search filter `updated_from` work? | Yes. It returned exactly the constituents whose `updated_at` falls on or after the given moment, to the second. One request, under half a second. |
| Does a change to an address, email or phone move the constituent's own `updated_at`? | Yes, on every add and every edit made through the API. For edits made in the LGL screen this rests on history: no sub-record in the account is newer than its constituent. |
| Can name fields and the deceased flag be updated? | Yes, with `PATCH /constituents/{id}`. Lists that are not sent are left alone. The deceased date can be set and cleared. |
| Can one address, email or phone be edited in place? | Yes, by its own id: `PATCH /street_addresses/{id}`, `/email_addresses/{id}`, `/phone_numbers/{id}`. Other entries are untouched. |
| Can an entry be added? | Yes: `POST /constituents/{id}/street_addresses` and the same for emails and phones. The first address added becomes preferred; later ones do not. |
| Does the gift search filter `updated_from` work? | Yes, by date: it returned exactly the 37 gifts updated in the previous 14 days, in under a second. In the one case tested it did not honor the time of day, so the service asks by date and ignores gifts it already holds. |
| Does a new gift move the constituent's `updated_at`? | No, not reliably: 74 constituents have a gift newer than their own timestamp. Gifts need their own request. |
| How long is a pull? | All constituents with their lists: 13 seconds, 2 requests. Gifts are the rest of the 95-second full pull. |

Three things the tests showed that the design must respect:

- **Changing a first name does not update LGL's addressee or salutation.**
  LGL mails from the addressee, so a name copied from VG leaves the old name
  on the envelope. See "For the customer".
- **LGL stores what it is given.** A spelled-out state and a ZIP+4 were kept
  as sent. The service sends cleaned values.
- **A two-line street is kept as two lines.** A VG street and unit go to LGL
  as two lines of one street value.

### On the trial account, 2026-11-12 and 13

The trial account (see "Testing the write paths") has the same settings as
production: email validation, salutations, address verification with
automatic cleanup of saved addresses, and daily deduplication of addresses
and of phones. The script is `spike/lgl-trial.mjs`. It writes only after
checking that the key reaches the trial account: a constituent count under
200 and a sentinel record created by hand there.

| Question | Result |
|---|---|
| Does the API refuse or merge a duplicate entry? | No. An exact repeat of an address, phone or email is added as a second entry, as is every variant tried ("St" for "Street", capitals, ZIP+4, state spelled out; phone in five formats; email in other capitals). An entry edited to equal another is accepted. |
| Does the API refuse an invalid email? | No. It returns 200 and stores the address marked `not_current` when the form is wrong (no `@`, no dot in the domain, a space inside). A well-formed address at a domain that cannot exist is stored as current. Leading and trailing spaces are trimmed. |
| What does LGL hold as a phone's comparable form? | `normalized_number`: the digits, with `+1` dropped (`4015550100`). An extension is appended to the digits. |
| What are a new constituent's addressee and salutation? | With only a first and last name: addressee "First Last", salutation "First". Other name shapes are not yet tested. |

LGL's deduplication of addresses and phones is not done when an entry is
saved. It is a cleanup job that runs once a day and "leaves only one copy of
each unique" address or phone. A test record holding the duplicates above
was left for the job and read again on 2026-11-13:

| Entries | Before | After | What the job treated as the same |
|---|---|---|---|
| Addresses | 7 | 3 | Exact repeats, a copy in capitals, and a copy with ZIP+4. It kept "St" for "Street" and the state spelled out as separate entries. |
| Phones | 8 | 2 | Every entry with the same `normalized_number`, whatever its format or type: a Mobile entry with the Home number was deleted. The number with an extension was kept. |
| Emails | 8 | 8 | Nothing; emails are not deduplicated, exact repeats included. |

In each group it kept the preferred entry, which was also the oldest. The
deleted entries are simply gone, and the constituent's `updated_at` did not
move. Not tested: which copy survives when the preferred entry is not the
oldest, or when one copy is current and another is not.

What this adds for the design:

- **The job's deletions are seen only by the full pass.** A change check
  asks for constituents by `updated_at`, which the job leaves alone.
- **A phone's type is not safe to rely on.** If the same number is on file
  as both Home and Mobile, the job keeps one, of either type. The
  comparison already treats a person's phones as a set of numbers
  (`fields.js`), so a type lost this way compares `same`. Type decides only
  which empty VG slot, phone or cell, a number from LGL fills first.

**Address verification is a sweep that runs about every ten to eleven
minutes** and takes every address not yet tried. An edit does not trigger
it. Two records were given real public addresses, typed untidy and in lower
case, in the same second. One was never edited. The other's address was `PATCH`ed with no change
of content five minutes later, and nothing followed. Both were verified in
the same second, 10 minutes 22 seconds after they were added. The sweeps
seen were at 01:16:53, 01:27:35 and 01:50:10 UTC (the gaps are 10m42s and
22m35s, about two periods). An address is therefore verified within about
eleven minutes of being saved, however it was saved.

Verification rewrites the address: street and city in title case, the
street suffix abbreviated ("street" to "St"), state in capitals, ZIP+4
added, and county, latitude and longitude filled in. It sets `verified`
and `verified_on`, and moves the address's `updated_at` and the
constituent's.

**It can also change the city and the ZIP, not only the form.** In the
harness's final run (2026-11-13) an address on a plausible real street in
one town was rewritten, about eleven minutes after it was saved, to the same
street name in a neighbouring town with a different ZIP. Whether that is
right for the person is not something the sync can tell.

Invented addresses go through the same sweep. They are stamped with
`verified_on`, `verified` stays false, and nothing is rewritten. A later
sweep did not try them again. So:

| `verified` | `verified_on` | Meaning |
|---|---|---|
| false | empty | not tried |
| false | set | tried, could not be verified |
| true | set | verified, and possibly rewritten |

What this means for the design:

- **Entry ids are not stable from one day to the next.** The job can delete
  the entry whose id the service last saw. The service finds entries by
  value on each run, and a write to an id that is gone is re-planned, not
  failed.
- **The service never adds an entry LGL already has.** Before adding, it
  looks for an entry with the same comparable value, current or not, and
  reuses it (marks it current and preferred) instead. Retries and repeat
  runs therefore add nothing, and the daily job never has a copy of ours to
  remove.
- **A 200 is not proof an email was taken.** After writing an email the
  service reads the entry back; one stored `not_current` opens a hold.
- **LGL rewrites every address the service sends, and that is an LGL
  change.** Within about eleven minutes the constituent's `updated_at`
  moves, so the next LGL check sees the record. The rewrites seen on
  2026-11-12 (case, suffix, ZIP+4) are inside the comparable form, which already reduces
  suffixes and directionals to the USPS abbreviations (`fields.js`): the
  field compares `same` and nothing is written back. Any rewrite found
  outside it must be added to the comparable form, or that address comes
  back as a change and is written again on each pass; the flapping guard
  is the backstop, not the fix. A rewrite of the city or ZIP is outside it
  by design: it is a real change of value. For a real donor, an address the
  sync sends to LGL at step 7, or any address staff save in LGL, can be
  rewritten by the sweep about eleven minutes later. After agreement that is
  an `lgl-changed` case, and policy copies it to VG. That is intended: a
  rewrite to the proper post office town and ZIP is what VG should hold
  (the engineer's ruling on finding (d), 2026-11-14). Not yet seen: how
  verification writes a unit.
- **An address LGL could not verify is visible:** `verified_on` set with
  `verified` false. It is a candidate for a hold or a staff list, not a
  reason to refuse the write; the customer has not been asked.
- **The settings can be changed.** If deduplication or automatic address
  cleanup gets in the way, the engineer can turn it off on the production
  account. It is the customer's account, so the customer is told.

From the sibling projects:

- **`person` has no change timestamp**, and `audit_event` has no read
  endpoint. The service needs a new endpoint to learn what changed in VG.
- **The app does not resolve a town on the server.** The browser calls `POST
  /op/geocode/town` and sends the result. The service does the same, so
  towns need no app change.
- **`donor:write` is held by no role but Admin** and the service's own role,
  and the app has no screen that adds or removes a donor row. **Whether a
  person is a donor is decided by LGL alone, through this service** (the
  engineer, 2026-11-14). Staff do not remove donor links, so a person with
  no donor row is never a staff decision for the sync to respect.
- **The API and Keycloak are not on the VM.** They are Azure App Service
  sites reached over public HTTPS.

## Terms

- **Linked pair**: a VG person with a `donor` row, and the LGL constituent
  the row points to.
- **Field**: one unit that is compared and copied as a whole. See the field
  table.
- **Agreed value**: the value of a field at the last moment the two systems
  were known to hold the same thing. This is the sync memory.
- **Hold**: a recorded decision to leave something alone. A hold stays open
  until the data changes or someone dismisses it.
- **Check**: a quick look at what changed in one system since the last look.
  There are two, the VG check and the LGL check.
- **Full pass**: a comparison of everything. In log lines and the run table,
  "pass" means a check or a full pass.

## Shape

Node 24, ES modules, the built-in test runner, global `fetch`, no runtime
dependencies unless one earns its place. **(call)** This matches the code
being ported from `lgl-import`.

The service is a long-lived container, like the email sidecar. A small
scheduler stays up and runs two kinds of job, one at a time: a tick, armed
60 seconds after the previous tick ended, and a full pass every night. Each
tick runs the check for VG changes; every fifth tick (every fifteenth after
an idle hour) the same tick then runs the check for LGL changes. The ticks
start after the first successful full pass. The aim is that an edit in VG
reaches LGL in about a minute, and an edit in LGL reaches VG within about
five while the office is active (fifteen after an idle hour). A new gift is
picked up by the same LGL check.

| Module (`src/lgl-vg/`) | Job |
|---|---|
| `main.js` | Starts the scheduler, or runs one check or full pass by hand |
| `scheduler.js` | Runs the tick (the checks) and the full pass; never two at once; reports check failures; stops cleanly on shutdown |
| `config.js` | Environment and the policy file |
| `lgl.js` | LGL client (ported), read and write |
| `vg.js` | VG API client, client-credentials sign-in |
| `donors.js` | The donor rule and last gift date (ported from `classify.js`) |
| `fields.js` | How each field is read from each system's record, cleaned and compared, and what a write of it contains |
| `clean.js` | Cleaning of LGL values (ported from `person.js`) |
| `compare.js` | Three-way comparison; returns a case |
| `policy.js` | Looks a field and case up; returns an action |
| `match.js` | Matching unlinked donors (ported from `lgl-import/count.js` and `src/suggest.js`) |
| `plan.js` | Turns the above into a list of intended writes, including the rules for one constituent linked to two people |
| `apply.js` | Carries out the plan; records memory and holds (step 3 keeps no write log) |

Everything from `donors.js` to `plan.js` is pure: data in, decisions out, no
network. That is where the tests go. `lgl.js`, `vg.js` and `apply.js` are
the only modules that do I/O, tested with the fake-`fetch` pattern from
`lgl-cleanup`. The checks and the full pass feed the same pure code; they differ only
in how much they read. The policy lives in `policy.json` at the repo root.
The later Mailchimp executable gets `src/mailchimp/` and shares nothing.
The brief had the two executables run one after the other. With this one
long-lived, how the Mailchimp executable is scheduled is decided in its own
design.

## Checks and the full pass

| | VG check | LGL check | Full pass |
|---|---|---|---|
| When | Every tick: 60 s after the previous tick ended | After the VG check of every fifth tick; every fifteenth when idle | Nightly |
| Asks | VG: which people changed since the last check (one call to our own API) | LGL: constituents updated since the last check, and gifts updated since the day before the cursor's date (two requests) | Everything: every constituent and gift (7 requests, about 95 seconds), every person, all memory and holds |
| Covers | Linked pairs whose VG person changed | Linked pairs whose constituent changed; last gift date and new donors where gifts changed | Every linked pair, last gift date, the donor rule, unlinked donors, constituents that have gone missing |

**The full pass is the safety net.** It compares everything, so anything a
change check missed is caught within a day. Deleted gifts and deleted or
merged constituents are seen only by the full pass, because a search for
changes cannot return something that is gone.

### A full pass

1. **Sign in and check.** Get a token, confirm the service's permissions
   with `GET /user`, load the policy file. Fail here if anything is missing.
2. **Read.** Pull LGL in full. Read every VG person with `GET
   /persons?projection=detail`. Read the sync memory and the holds.
3. **Sanity checks.** Stop without writing if the LGL pull is incomplete, or
   if the constituent count has fallen by more than a set fraction since the
   last full pass.
4. **Linked pairs.** For each pair and each field, compare and decide.
   Refresh the last gift date.
5. **Unlinked donors.** For each LGL person-donor with no link, match.
6. **Circuit breaker.** If the plan would change more people than a set
   limit, stop without writing and fail the pass. **(call)** The limit is
   configuration; start at 50 people. Recording agreed values does not
   count, so the first live pass, which mostly records memory, is judged
   only on the people it would link, create or change. **(call)** The limits
   are `CIRCUIT_BREAKER_PEOPLE` (default 50) and
   `MAX_CONSTITUENT_DROP_PERCENT` (default 10) in `.env`. `--max-people N`
   overrides the breaker for one run by hand, for the first live pass.
7. **Apply.** Carry out the writes one at a time. Immediately before each
   write, re-read the record about to be written and confirm it still holds
   the value the plan saw. If it does not, skip the write and leave the
   field for the next check. After each successful write, record the new
   agreed value and, for a write to LGL, a log row. A write to VG is
   already in `audit_event`.
8. **Summarize.** Record the run with its counts and both cursors. The VG
   cursor is `null` until step 6.

A crash between a write and its memory update heals itself: the next pass
finds both systems changed to the same value and records it as agreed.

**When a write fails.** A refusal by the other system (a validation error)
opens a hold with the reason, and the pass carries on. LGL refuses little:
an email it judges invalid is accepted and stored as not current, so that
counts as a refusal too (see "On the trial account"). A failure that may
clear (the network, a server error, the rate limit) fails the check or pass:
it prints `PASS FAILED`, does not advance its cursor, and the next one
retries. Retrying is safe because every decision is made by comparing
current values.

**(call)** A refused VG write opens a `vg-refused` hold and is not retried
while the values it saw are unchanged, whether the hold is open or dismissed.
When VG refuses a PATCH of several fields, each field is tried alone, so only
the refused ones are held. The re-read lists the persons linked to the planned
constituent (the single-person read has no detail projection); a person
missing from it has had its link changed, and the write is skipped as stale.

### A change check

The VG check and the LGL check work the same way, each against its own
system.

1. Ask the system what changed since its cursor: VG for audit rows after the
   VG cursor, or LGL for constituents with `updated_from` set to the LGL
   cursor.
2. Find the touched constituents. In the VG check, those linked to a
   changed person; changes to a person with no link wait for the full
   pass. In the LGL check, every constituent returned that is new to the
   cache or whose `updated_at` differs from the cached copy's, and every
   constituent with a new or changed gift. For each touched linked
   constituent, read the other side and the pair's memory rows. For a
   couple, read both partners. **Every field of a touched pair is
   compared**, not only the fields an audit row names: a pair is decided
   as a whole, exactly as a full pass decides it.
3. Compare, decide, apply and record exactly as a full pass does, for the
   touched constituents only. Unlinked donors (LGL check) are matched over
   **every** unlinked donor in the cache, as a full pass matches them,
   because matching compares donors with each other (two donors that would
   link to one person, a donor that looks like another); the results are
   then cut to the touched constituents. Only holds on touched
   constituents are reconciled, so a check never closes a hold on anyone
   it did not look at.
4. Advance that cursor.

**A check never unlinks.** A linked constituent gone from LGL and one that
is no longer a donor (`lgl-missing`, `no-longer-donor`) are left to the full
pass, the only one that sees deletions. A check drops those results and
their unlinks from its plan, and leaves any hold already open for those
reasons as it is.

Most checks find nothing new and end there: a quiet VG check costs one feed
request (more only when the feed has pages to follow), a quiet LGL check its
two searches. A check has "found
a change" when its plan holds a write, a deferred decision, a hold opened,
changed or closed, a memory row recorded, a link, a create, or a new last
gift date. Steady states are not changes: a donor skipped, an open hold that
stays open unchanged, a dismissed hold left dismissed. Only a check that
found a change prints a line and appends to the decisions file, and only
one of those writes a run row, when writing is on.

**Gifts in the LGL check.** The service keeps the gifts from the last full
pass in memory. Each LGL check asks for gifts updated since the day before
the cursor's date, ignores those it already holds unchanged, and adds the
rest. The extra day is there because it is not known whether LGL reads a
bare date as UTC or as the account's local time. For each
constituent touched it recomputes the donor rule and the last gift date. A
linked donor gets the new date in VG. An unlinked person who has just become
a donor is matched as in "Unlinked donors", which needs one read of all VG
people. So a first gift recorded in LGL makes its donor appear in VG within
the same few minutes.

**Limits on checks.** The circuit breaker counts the people changed by all
checks together over the last 24 hours since the last successful full pass,
read from the `ok` check run rows, against the same limit as a full pass. **(engineer, 2026-11-15)** Someone whose only
change is a new last gift date does not count: gift dates are routine in a
busy giving season and would trip the breaker as ordinary work. Field
writes, links, follows, finishes and creates count. Each check run row
stores this figure as `breakerPeople`, beside `peopleChanged`. A check reads
at most 1000 check run rows for the count; if it gets that many, the count is
not complete and the breaker trips, failing safe. When the
breaker trips, the check writes nothing and reports `PASS FAILED`, and both
checks stop until the next successful full pass, which clears the trip (the
full pass has its own breaker). Separately, a VG check that finds more than
20 linked people changed does not read LGL one record at a time, which would
run into LGL's rate limit. It decides those pairs from the LGL cache, which
is at most one LGL check old, and still advances its cursor. Queuing a full
pass instead would loop: a full pass's own writes come back in the feed.

The VG check runs more often because asking our own API is nearly free, and
because the API already records every change to a person in `audit_event` as
part of the change itself. This is the same idea as the email sidecar's
notification table, read through an endpoint.

**The LGL check backs off when idle.** After an hour in which neither check
has found a change, it runs on every fifteenth tick instead of every fifth.
The service start counts as a change. The first change seen on either side
returns it to five: if five or more ticks have passed since the last LGL
check, it runs on that same tick, after the VG check that found the change,
or on the next. The count goes up on every tick, whatever the VG check did.
It follows activity, not the clock, so late evenings and holidays need no
schedule. The VG check runs on every tick always. An LGL 429 puts the LGL
check off to the first tick after LGL's five-minute pause.

**Cursors.** The LGL cursor is the newest `updated_at` the service has seen,
taken from LGL's own clock. Each LGL check asks from two minutes before the
cursor, and a full pass sets it to five minutes before the newest
`updated_at` in its pull, so a record edited while a read was under way is
read again and never missed. The VG cursor is the highest audit id handled.
The feed scans audit rows past the cursor in id order and stops at the first
missing id, since a gap is a write not yet committed. Only when the row after
the gap is older than `VG_SYNC_CHANGE_GAP_SECONDS` (60) does it take the gap
for a rollback and go past it. So a change that commits late is not skipped;
one made just after a rolled-back write is seen up to a minute late. The
overlap means the LGL check reads the newest constituent it has seen (and
any edited in the two minutes before) again on every check. A constituent
read again with the same `updated_at` as its cached copy touches nothing, so
the overlap does not make a check find a change; a VG audit row is never
read twice.

**Time zones.** LGL returns every timestamp in UTC, and the constituent
search honors a UTC timestamp to the second. The cursors are LGL's own
timestamps and VG's audit ids, so nothing depends on the VM's clock or time
zone. Gift dates and deceased dates are plain dates with no time, copied as
they are. The nightly full pass is scheduled in UTC, at an hour that is
night in the customer's time zone.

Both cursors are kept in the process and saved in every run row. **(call)**
The service runs a full pass every time it starts, because the gifts it
keeps in memory have to be reloaded. The cursors then come from that pass.

**The VG cursor** is set by the full pass. Before it reads VG people, the pass
reads the change feed through to its end (pages of 1000, following `more`),
starting from the last cursor known: the service's own, else the newest run
row with a non-null `vgCursor`, else 0. It ignores what the feed says and
records the last `lastAuditId` as `vgCursor` in the run row, next to the LGL
cursor (five minutes before the newest `updated_at` pulled). Anything changed
after that point is newer than the people the pass reads. A page that says
`more` but whose `lastAuditId` does not pass the cursor fails the pass (or
the VG check) with `the VG change feed did not advance past audit id <n>`,
rather than asking for the same page until the timeout.

**The service's own writes** come back as changes on the next check. They
compare as `same` and cost one extra read.

### Dry run

Nothing is written unless asked. **(call)** There are two switches, one for
writing to VG and one for writing to LGL, so VG writes can be exercised
against a restored snapshot while the real LGL is only read. The running
service takes them from `.env`; one run by hand (`main.js --once full`,
`--once vg-check` or `--once lgl-check`) takes them as `--write-vg` and `--write-lgl`.
With neither, a pass writes nothing at all, including memory, holds or the run
row, and prints its decisions as JSON lines.

**(call)** A full pass by hand is `node src/lgl-vg/main.js --once full
[--write-vg] [--max-people N] [--out dir] [--snapshot file]`. It replaced
the `full` command in step 5.

**(call)** One change check by hand is `--once vg-check [--write-vg]
[--after <auditId>] [--out dir]` or `--once lgl-check [--write-vg] [--since
<ISO time>] [--out dir]`. The cursor is the option, else the newest run row's
`vgCursor` or `lglCursor`; with neither the command exits 2 and asks for it.
`vg-check` starts with an empty cache and reads every touched constituent
and its gifts; `lgl-check` first pulls every constituent and gift, so it
cannot take a known gift for a new one. That pull has read every edit
already, so it is cut back to the cache the service would have held at the
cursor: the constituents updated since the check's constituent search starts
(two minutes before the cursor) and the gifts updated since its gift search
starts (the day before the cursor's date) are left out, and count as new. Both keep the full pass's LGL retries
(the run is attended), print the counts and the `CHECK OK` line, and on
failure print `CHECK FAILED <kind> <message>` and exit 1 at once.

**(call)** `--snapshot` refuses `--write-vg`. A stale snapshot reads as
`lgl-changed` against newer memory and would write old values into VG.

## Comparing a field

Both values are first reduced to a comparable form: trimmed, case-folded,
accents and punctuation removed, state reduced to its code, ZIP to five
digits, phone to ten digits. Two values that differ only in those ways are
the same value. The comparable form is used only to compare; what is written
is the cleaned value.

The comparison takes three inputs (LGL now, VG now, the agreed value) and
returns one case:

| Case | Meaning |
|---|---|
| `same` | Both equal the agreed value. Nothing to do, nothing logged. |
| `first-match` | There is no agreed value yet and the two match. Record it as agreed. |
| `converged` | Both changed, to the same value. Record it as agreed. |
| `lgl-changed` | Only LGL differs from the agreed value. |
| `vg-changed` | Only VG differs from the agreed value. |
| `lgl-cleared` | As `lgl-changed`, and LGL is now empty. |
| `vg-cleared` | As `vg-changed`, and VG is now empty. |
| `both-changed` | Both differ from the agreed value and from each other. |
| `never-agreed` | There is no agreed value yet and the two differ. |

A pair seen for the first time has no agreed value. Fields that match are
recorded as agreed. Fields that differ are `never-agreed`. At go-live this is
every difference that exists today between linked people.

## The policy file

`policy.json`, checked in. **(call)** It is a file in this repo, not a table
in VG: a customer answer becomes a one-line commit with a date and a reason,
it is reviewed like any change, and it holds no personal data.

Each row names a field, a case, and an action. A `*` row for every field is not supported yet:

| Action | Effect |
|---|---|
| `to-vg` | Copy LGL's value to VG. |
| `to-lgl` | Copy VG's value to LGL. |
| `hold` | Leave both alone and open a hold. |

A field and case with no row is `hold`. A row can carry a note and the date
the customer decided it.

The file as it ships, from the customer's answers of 2026-11-12 (see "For
the customer"):

| Field | `lgl-changed` | `vg-changed` | `both-changed` | `never-agreed` | `lgl-cleared`, `vg-cleared` |
|---|---|---|---|---|---|
| first name, last name, suffix, nickname | `to-vg` | `to-lgl` | `to-lgl` | `hold` | `hold` |
| address | `to-vg` | `to-lgl` | `to-lgl` | `to-lgl` | `hold` |
| email | `to-vg` | `to-lgl` | `to-lgl` | `to-lgl`; `hold` if VG has none | `hold` |
| phone, cell | `to-vg` | `to-lgl` | `to-lgl` | `to-lgl`; `to-vg` if VG has none | `hold` |
| deceased | `to-vg` | `to-lgl` | `to-lgl` | toward the side marked deceased | `hold` |

- The `lgl-changed` and `vg-changed` columns are the customer's "two-way":
  an edit made in one system reaches the other.
- `both-changed` is `to-lgl` everywhere: the customer chose "Village Green
  wins" (question 1). LGL's value is logged, so it can be put back.
- `never-agreed` follows question 2 (addresses, guarded for PO boxes) and
  question 3 (phones and emails from VG; a number only LGL has comes to VG;
  names and nicknames held and listed). **(call)** An email only LGL has is
  held, not copied to VG: question 3 promised that for numbers, and a new VG
  email can put a person on VG's mailings.
- Clearing a value is held in both directions. It was not asked, and
  "nothing in LGL is deleted" points that way.
- For deceased, question 4: the mark goes either way with its date, and is
  never removed by the service (see the guard below).

The `to-lgl` rows have no effect until writing to LGL is built and switched
on.

Record-level situations are rows in the same file:
`lgl-missing` (a linked constituent is absent from the pull: deleted or
merged) and `no-longer-donor` (a linked constituent no longer passes the
donor rule). The one other action available to them is `unlink`, which
removes the VG donor row. Per question 5, `lgl-missing` is `unlink`: the
person stays in VG without the Donor mark, and the item goes to staff.
`no-longer-donor` was not asked and stays `hold`.

**(call)** Actions not built yet are `deferred`. The full pass reports and
counts them, and makes no memory, hold or write for them. They are `to-lgl`
and the LGL half of a `merge` and of `toward-deceased`. The record action
`unlink` was deferred in step 3 and is built in step 4 (see "Unlinked
donors", "Gone from LGL").

Two more rows are settings, not cases. `couple-lgl-changed` says what a
change to a couple's shared LGL record does in VG; it ships as `to-vg` (both
partners), question 7. `lgl-addressee` says whether a name copied to LGL
also rewrites LGL's addressee and salutation; it ships as `if-default`,
question 6: rewrite them only where they still read exactly as LGL would
have generated them from the old name, otherwise leave them and list the
record.

### Guards

These are engineering safety, not business rules. They are code, they run
before the policy lookup, and each produces a hold:

- **Unclean.** An LGL value that fails cleaning (a malformed address, an
  email without a domain) is never copied to VG. This blocks only an action
  that would copy LGL to VG (`to-vg`, `merge`, `toward-deceased`); a copy
  from VG that would repair it goes ahead (and in step 3, where LGL writes
  are deferred, is reported as deferred). An unclean value is treated as
  differing from every clean one, so the case is `never-agreed`, `lgl-changed`
  or `both-changed` as usual. The first code held `unclean` for any action,
  against this text; the harness's step 3 scenarios found it and the code was
  fixed to match (2026-11-13). When the field is held for any reason while
  LGL's value is unclean, the reason is `unclean`, with the case kept in the
  detail: malformed takes priority. The hold's detail shows LGL's value as
  stored, and its fingerprint is built from that raw value, so a change from
  one malformed value to another reopens a dismissed hold (the engineer's
  rulings on findings (b) and (c), 2026-11-14).
- **Ambiguous entry.** LGL has more than one current entry of a kind and
  none is marked preferred (see "LGL's lists").
- **Couple.** See "Couples".
- **Flapping.** A field that has been copied back and forth more than three
  times in thirty days. **(call)** This guard waits for step 6. It needs a
  history of writes in both directions, and with VG writes only in
  `audit_event` there is none to read yet. A full pass run by hand cannot
  flap.
- **Lost nickname.** A copy to VG that would remove a "First (Nick)" form.
- **PO box.** A copy to LGL that would replace a PO box as LGL's preferred
  address (question 2).
- **Deceased removed.** A copy in either direction that would clear a
  deceased mark (question 4). Undoing one is done by a person, in both
  systems.

## Fields

| Field | VG | LGL | Notes |
|---|---|---|---|
| first name | `firstName` | `first_name` | Compared with any "(Nick)" part set aside. |
| last name | `lastName` | `last_name` | |
| suffix | `suffix` | `suffix` | |
| nickname | `nickname` | `nick_name` | |
| address | `street`, `unit`, `city`, `state`, `zip` | the preferred entry of `street_addresses` | One field. An address moves whole or not at all. |
| email | `email` | the preferred entry of `email_addresses` | |
| phone | `phone` | the preferred non-mobile entry of `phone_numbers` | |
| cell | `cell` | the preferred mobile entry of `phone_numbers` | |
| deceased | `deceased`, `deceasedDate` | `is_deceased`, `deceased_date` | Compared as a pair: flag and date. |

Last gift date is not in this table or the policy file. It is computed from
LGL's gifts (the latest received date among counting gifts that are not
dues) and written to VG's donor row whenever it differs. VG never originates
it.

A name copied to LGL does not change LGL's `addressee` or `salutation`;
LGL leaves them as they were. The `lgl-addressee` setting decides whether
the service rewrites them. At `if-default` it rewrites them only when they
equal what LGL generates from the old name; a hand-written one is left and
the record goes to staff.

**(call)** A missing LGL last gift date never
clears VG's. When LGL's computed last gift date is null (no counting gifts),
no donor write is made; the `no-longer-donor` hold flags the record.

**(call)** LGL's generation rule is not documented;
the builder derives it from the account's records and tests it on the trial
account before relying on it. Where the rule is uncertain, the record is
treated as hand-written.

The fund and payment-type ids that define dues are LGL record ids. They are
configuration in `.env`, not constants in this public repo.

Writing to VG uses `PATCH /persons/{id}` with only the changed field. An
address write first asks `POST /op/geocode/town` for the town and sends it
along; if the lookup fails the address is still written and the missing town
is logged. Creating a person does the same lookup.

### LGL's lists

LGL holds a list of addresses, emails and phones; VG holds one of each (two
phones). **(call)** LGL's value for a field is its preferred current entry:
the one LGL itself mails, emails or calls. The memory records which entry
that was.

- If staff make a different entry preferred, LGL's value has changed, and
  the field is compared like any other change.
- If LGL has more than one current entry of a kind and none is preferred,
  the "ambiguous entry" guard holds the field.
- **(call)** A copy of an address to LGL adds VG's address as a new entry,
  makes it preferred, and marks the old preferred entry not current. LGL
  keeps the old address on file, and a person can restore it in the LGL
  screen. If LGL has no current entry, one is added. No entry is ever
  removed. The calls were verified on 2026-11-11. If VG's address is
  already on file as an entry, current or not, that entry is made current
  and preferred instead of adding a copy: LGL does not refuse duplicates,
  and its daily cleanup would delete one of the two.
- **(call)** Emails and phones are written the same way as addresses: VG's
  value is added as the preferred entry and the old one is marked not
  current. Question 3 told the customer "nothing in LGL is deleted";
  updating an entry in place would overwrite the old value.

Where LGL's preferred address differs from VG's on the day a pair is first
seen, the field is `never-agreed` for `address`. The first report on real
data (2026-11-11) found about 40 such donors among 763, 5 of them with a PO
box in LGL. The customer agreed (question 2): VG's address replaces LGL's,
except where LGL's address is a PO box, which is left alone and goes to
staff. That is `to-lgl` for `address` in `never-agreed` and `both-changed`,
with the PO box guard.

## Couples

A couple is any LGL constituent that two VG people link to. Each partner is
its own linked pair with its own memory.

- **Names are not synced for couples.** LGL holds "Pat and Lee" in one
  field; the service will not recompose it. **(call)** LGL's "Pat and Lee"
  never matches either partner, so each partner carries a `couple` hold on
  first name until someone dismisses it. A dismissed hold stays dismissed
  while the values are unchanged.
- **Deceased is not synced for couples.** One flag in LGL cannot say which
  partner.
- **A couple is compared as a unit.** Both partners are always read, in a
  check as well as a full pass. If LGL changed and a partner also changed,
  to a different value, the field is `both-changed`.
- **LGL to VG:** a change to the shared address, email, phone or cell goes
  to both partners. This is the `couple-lgl-changed` setting.
- **VG to LGL:** a change is copied only when both partners hold the same
  new value. If one partner changed and the other did not, the field holds.
  The service does not copy one partner's change onto the other by way of
  LGL.

**(call)** A couple is decided as a unit per field. A `to-vg` for a shared
field (address, email, phones) is applied to the partners only when no
partner's case for that field is `vg-changed`, `vg-cleared`, `both-changed`
or `never-agreed`. Otherwise every partner whose case is not `same` gets a
`couple` hold. For names and deceased, any case other than `same`,
`first-match` or `converged` is a `couple` hold.

**(call)** The last rule is deliberately cautious. One partner moving is
exactly the situation where a guess does harm.

The customer agreed (question 7, 2026-11-12) that the cases held here, one
partner renamed, marked deceased or changed alone in VG, go to staff to
handle one by one. For a partner who has died, staff will want LGL's record
to address only the survivor; staff make that change in LGL.

## Unlinked donors

On a full pass, every LGL person who passes the donor rule and has no VG
donor row is matched against all VG people. An LGL check does the same for
anyone whose gifts have just changed. Matching uses the import's rules: first name
matched against VG's first name, its "(Nick)" part and its nickname; email;
house number and ZIP.

Only the two outcomes that the import acted on without staff confirmation
run unattended:

| Outcome | Condition | Action |
|---|---|---|
| Link | Exactly one VG person matches on both email and name, and is not already a donor under another constituent. | `PUT /persons/{id}/donor` |
| Create | No VG person shares the email, the name, or the last name at the same house number and ZIP. The donor is not deceased, is not an "Anonymous" placeholder, has a last name, and has given within the horizon. | `POST /persons`, then the donor row |
| Hold | Anything else. | Open a hold with the reason. |

The horizon for creating people (five years in the import) is configuration.

Three more rules keep a pass from making duplicates:

- **A name that holds two people** ("Pat and Lee") is held. The import split
  these only with staff confirmation.
- **Two unlinked donors that resolve to the same VG person, or that look
  like each other** by the import's near-duplicate test, are both held.
- **Create is two calls.** The new person's id is logged before the donor
  row is written. A later pass that finds a logged create with no link
  finishes the link, after checking that the person's name still matches.

A newly linked pair has no agreed values, so its differing fields are
`never-agreed`. A newly created person is recorded as agreed on every field.

**(call)** Rulings from the step 4 plan (2026-11-14,
`docs/superpowers/plans/2026-11-14-lgl-vg-step4-unlinked-donors.md`):

- **An unlinked donor's hold is keyed by its constituent**, with no person
  and no field, so a donor has one such hold at a time. Its fingerprint is
  built from the reason, the VG people matching found (sorted ids) and LGL's
  last gift date; a rule dismissal is reconsidered when any of them changes.
- **A staff dismissal leaves the donor alone.** A constituent with a
  dismissed hold of kind `staff` and no person is not matched at all. It
  still counts in the near-duplicate test, so a look-alike of it is held.
- **Create is logged with a hold**, since `sync_log` is for LGL writes only.
  After `POST /persons` and before the donor row, a `create-unfinished` hold
  (person and constituent) is opened; it is closed once the donor row is
  written. A later pass that finds it open links the person, if it still has
  no donor row and its first and last names still match LGL's; otherwise the
  hold stays open. The new person's memory rows are written between the two
  calls: LGL's cleaned value per field, or null for a field LGL leaves empty.
  A field LGL holds but could not clean is left out of the person and gets
  no memory, so the next pass treats it as usual.
- **Linked and created pairs are compared on the next pass**, not the one
  that links them.
- **Before a link, create or finish, every VG person is read again** (one
  read, after the linked pairs' writes) and matching is run on it; anything
  whose decision changed is skipped as stale.
- **A refused link or create** opens a `vg-refused` hold with no person; it
  is not tried again while that hold, open or dismissed, has the same
  fingerprint.
- **The circuit breaker counts links, follows, finishes, creates and
  unlinks** as people changed; a create counts once, by constituent.

**Gone from LGL.** `lgl-missing` is `unlink` (question 5). **(call)** Before
removing the Donor mark, the pass treats the person as having no donor row
and runs matching: if exactly one unlinked donor matches the person on email
and name, that record is taken to be the one that replaced the gone record
(an LGL merge keeps one of the two), and the donor row is pointed at it in
one write ("follow"). Otherwise the donor row is removed and an `unlinked`
hold (person and constituent) is opened for staff; it closes when the person
is a donor again. A couple's record is never followed, since matching holds
couple names, so both partners lose the mark. An LGL merge leaves nothing
else the API can see (trial account, 2026-11-14): the merged-away id answers
404, as a deleted one does, and the kept record carries no pointer to it. The
kept record takes the other's gifts and, where staff tick them, its entries
(same ids, current, not preferred) and its name fields; its `updated_at`
moves, so the change check sees it. A name taken over in a merge is an
ordinary LGL change to the kept record.

**Staff decisions are not undone.** Before go-live, the import's skip and
hold decisions are loaded once into the holds table as dismissed holds, keyed
by constituent id. A dismissed hold made by staff is permanent. A dismissed
hold made by a rule (for example, "last gift before the horizon") is
reconsidered when the facts behind it change, such as a new gift. The seed
data holds real ids and goes into the VG database, never this repo.

**(call)** The load is `node src/lgl-vg/main.js seed-import --file
<import-prod-*.json> [--write-vg]`, dry by default, reading the import's run
file (`vg-utils/lgl-import/out/`). One hold per constituent:

| Import decision | Hold |
|---|---|
| Staff chose Skip | dismissed, kind `staff`, reason `import-skip` |
| Skipped, last gift before the horizon | dismissed, kind `rule`, reason `before-horizon`, with the fingerprint matching gives it |
| Skipped, "Anonymous" placeholder | dismissed, kind `rule`, reason `anonymous` |
| Held by the import | **open**, reason `import-hold` |

The import's own holds (rows staff never confirmed, and two LGL rows pointing
at one VG person) were never decided by anyone, so they are loaded open, not
dismissed: a dismissed row would hide them from the count staff will see.
The sync leaves such a donor alone while the hold is open, and closes it once
the donor is linked by hand or is no longer an unlinked donor. Where a
couple's two rows differ, `import-skip` wins, then `import-hold`. A
constituent linked in VG today, or already holding one of these holds, gets
nothing, so a second run adds nothing. A skip for a reason the command does
not know stops the whole load.

**What a hold means with no staff.** A hold closes by itself when the data
changes so that the match becomes clean, for example when staff correct a
name in either system. Otherwise it stays open and is counted in every full
pass's summary. The engineer can dismiss one, or link the pair by hand through the
API. There is no other resolution path in this design.

**Holds on fields.** A field hold closes when a later comparison of that
field no longer produces it: the values agree again, or the policy now gives
an action. Dismissing one accepts the disagreement as it stands; it stays
dismissed until either value changes, and it does not touch the memory. If a
person's donor row is removed or pointed at a different constituent, that
pair's memory rows are discarded and its holds closed, and the new pair
starts fresh.

**(call)** Hold reasons. A policy hold's reason is its case: `never-agreed`,
`both-changed`, `lgl-cleared` or `vg-cleared`. The guards' reasons are
`unclean`, `ambiguous`, `couple`, `lost-nickname`, `deceased-removed`,
`phones-no-slot` and `vg-refused`. The record situations' are `lgl-missing`
and `no-longer-donor`. Step 3 owns exactly these reasons on holds with a
`personId`, and closes only holds it owns. Step 4 owns the holds with no
`personId` whose reason is a matching reason (`anonymous`, `deceased-in-lgl`,
`couple-name`, `no-last-name`, `already-linked-elsewhere`, `multiple-matches`,
`shared-email-different-name`, `name-only`, `same-address-last-name`,
`before-horizon`, `duplicate-in-lgl`), `import-hold` or `vg-refused`, and
the person-level `create-unfinished` and `unlinked`. `import-skip` is never
closed by the sync.

## What is stored in VG

Four tables, added by a migration in `village-green`, reached through new
endpoints under a new scope `vg:sync` and permissions `sync:read` and
`sync:write`. The exact OpenAPI is settled in that repo; this is what the
service needs.

| Table | One row per | Holds |
|---|---|---|
| `sync_field` | person and field | the constituent id, the agreed value, the id of the LGL entry it corresponds to, when it was agreed |
| `sync_hold` | thing left alone | constituent id, person id if any, field if any, reason, a fingerprint of the values seen, first and last seen, state (open, closed, dismissed), who dismissed it |
| `sync_log` | decision that did something | run id, time, constituent id, person id, field, case, action, old and new value, outcome |
| `sync_run` | check that did something, and every full pass | kind of pass, start, end, switches, image revision, policy file hash, counts, result, the LGL and VG cursors |

**(call)** `same` is not logged. With about 770 pairs and nine fields, a row
for every unchanged field would be some two million rows a year that say
nothing. The run row carries the count. This narrows the brief's "one row
per decision, including did nothing": a decision to hold is recorded once in
`sync_hold` and logged when it opens, changes or closes, not on every pass.

**(call)** `sync_log` is for LGL writes only. The app made it so: a log row
must carry the request sent to LGL, and the table is described as "the only
record of writes to LGL". Writes to VG are already in `audit_event`. So the
full pass (step 3) writes no log rows. Its decisions go to
`out/full-<stamp>.jsonl` and the run row's counts.

**(call)** Holds are their own table, separate from the memory. The brief
had a disagreeing field simply keep its old memory. That still happens; the
hold row adds the reason, and makes "what is the sync leaving alone right
now" a single query.

Endpoints, all bulk because a full pass reads everything:

- list the people changed after a given audit id, with the fields that
  changed and the newest audit id. This is how the service learns what
  changed in VG. It is not specific to donors, so the later Mailchimp
  executable can use it with its own cursor.
- read all memory rows, or those for a list of people; upsert a batch
- read open and dismissed holds; open, update and close a batch; dismiss one
- start a run; finish a run; read recent runs
- append a batch of log rows

A restore of a VG snapshot brings the memory, holds and log back to the same
moment as the people, which is the reason they live there. The brief's
warning that a restore can reuse person ids applies to records kept outside
the database; these are restored together with the people they describe.

### Change times: not needed

"The newer change wins" would have needed an endpoint returning when each
field last changed according to `audit_event`. The customer chose "Village
Green wins" instead (2026-11-12), so it is not built. LGL dates only the
whole constituent, not each field, so "newer" would have favored LGL
whenever another field on the record was edited later.

## Telling staff

The customer asked (2026-11-12) that the items the service leaves alone be
sent to staff, who handle them one by one. These are the holds: PO boxes,
names and nicknames that differ, hand-written addressees, couples, deceased
marks it will not remove, donors deleted from LGL, and the guards' holds.

How they reach staff is open: who receives them, and by what route. Until
it is decided, holds stay in `sync_hold`, are counted in each `PASS OK`
line, and can be queried. **(call)** The engineer's suggestion is a daily
email listing new holds, with a link to each person in VG, sent through the
app's existing email path; it adds no new system and sends nothing on a day
with no new holds. A hold is sent once, when it opens. A conflict that VG
won (question 1) is logged, not sent.

## The service's identity in VG

- A confidential Keycloak client named `vg-sync`, the same name in
  development and production, with only the service-account
  (client-credentials) flow enabled. The token URL must be the public realm
  URL, so the issuer matches what the API expects.
- The client id is configuration (`VG_CLIENT_ID` in `.env`). Development
  signs in with a client secret. Production is expected to sign in with a
  signed JWT instead, the private key being a bind-mounted file like the
  email sidecar's key. That is added with the deploy step; Node's built-in
  crypto can sign it, so it needs no dependency.
- The API creates a `user_data` row for it on first request. Audit rows
  carry that user id.
- **(call)** A new role, added by migration, holding exactly: `person:read`,
  `person:write`, `member:read`, `volunteer:read`, `donor:read`,
  `donor:write`, `sync:read`, `sync:write`. The alternative is granting
  Admin, which is far more than the service needs. The member and volunteer
  read permissions are needed because the app hides a person from a caller
  who cannot read any of that person's associations, and matching must see
  everyone.
- Scopes: `vg:person`, `vg:donor`, `vg:sync`, `vg:read`.
- The grant is federation-level: donors span all thirteen villages and many
  have no village.
- The API requires a privacy acknowledgement from every user. It is recorded
  once for the service account during setup.

## Testing the write paths

LGL publishes no sandbox, so the LGL write path is proven in layers before it
writes to production.

1. **Decision logic, by unit tests.** Comparison, policy, couples, matching
   and planning are pure; every case in this design has a test with invented
   data.
2. **VG writes, against a restored snapshot.** The service runs with VG
   writing on against the engineer's local VG, which can be reloaded at will.
3. **LGL writes, printed, not sent.** With LGL writing off, every LGL write
   is printed as the exact request it would send: method, path and JSON body,
   for example `LGL PATCH /street_addresses/<id> {"street": "..."}`. The
   engineer edits donors in the local VG, runs one check by hand
   (`--once vg-check`), and checks each printed call against the record in
   the LGL screen. The snapshot's donor links point at the real LGL records,
   so the calls are real. Differences that arose in LGL since the snapshot
   print too.
4. **Production LGL, in stages.** Before the first write run: a dry run's
   printed calls are reviewed, and a full LGL snapshot is saved (the sync log
   also records every value replaced). LGL writes are then limited by an
   allow-list of constituent ids: first invented test records, then a few
   real donors checked by hand in LGL afterwards, then everyone. The circuit
   breaker caps every run.

**A trial LGL account for step 3 (2026-11-12).** LGL's Advanced
Integration Options Guide (February 2024) offers a free test account through
its Affiliate Program, so the engineer applied. LGL support replied that the
program is meant for consultants who refer several nonprofits. In its place
they offered an ordinary 30-day trial account, which they will extend to
about three months while the integration is built. The trial account is
`tvcritest.littlegreenlight.com`, and LGL has been asked to extend it. API
access for it has been requested and is **awaiting LGL's approval**. Once it
is approved, the engineer generates an API key for the trial account and
keeps it in `.env.trial`, separate from the production key. The API host is
`api.littlegreenlight.com` for both accounts, and only the key decides which
one a call reaches. The trial account will be seeded with invented donors.
It is for experiments in `spike/`, and, since 2026-11-13, the LGL side of
the test harness (`2026-11-13-test-harness-design.md`): invented scenarios
seeded into it and the local dev VG database, run through the real service.
Nothing in the service's code knows about it; the service reaches it only
through the harness's environment file. The experiments owed are: how LGL builds its default
addressee and salutation (question 6), whether address verification rewrites
a real address and how quickly an address is verified, and whether emails
and phones marked not current behave like addresses.
The build does not wait for the key: steps 1 to 6 need no LGL writes, and
layers 1 to 3 above stand without it. It is wanted before step 7 is switched
on.

The same guide settles three facts:

- **LGL pushes nothing out.** Its four integration routes are an inbound
  webhook endpoint (write only), the API, Zapier, and scheduled reports
  published to a fixed link (read only). Polling stands.
- **Writes through the API are not logged in LGL's history** that staff see
  ("Is data logged so user can see the history? No"). Confirmed on the trial
  account (2026-11-14): LGL keeps no per-record edit history at all. The
  record's details show only the last change, as "Updated by API User on
  <date>", which the overnight dedup does not move. Staff can see that the
  sync touched a record and when, not what changed. The sync log in VG is
  the only record, so a way for staff to look up a person's sync history
  belongs in the follow-up staff view. Writing an LGL note for each change is
  possible (contact reports are writable) and is a customer question if
  wanted.
- **The rate limit is 300 requests in any 5-minute period**, and API writes
  need the exact constituent id; LGL does no matching of its own.

## Deploy and operation

- **CI** as in `vg-email-sidecar`: tests on pull requests with no secrets;
  on merge to `main`, test, build `linux/amd64`, push `:<sha7>` and
  `:latest`, print the digest.
- **Compose.** An ordinary service in the VM's compose file, pinned by
  digest and started by `up`. It bind-mounts `.env` and needs only outbound
  HTTPS.
- **Deployer.** `vm-sidecar-deploy` is generalized to take a table of
  services, each with its own image, startup markers and failure patterns.
  **(call)** Generalize rather than copy: two copies would both rewrite the
  same compose file under separate locks.
- **Startup markers.** The service prints a fixed line when it has signed in
  to VG, when it has reached LGL, and when the scheduler starts. The
  deployer's health gate waits for all three.
- **Shutdown.** On `SIGTERM` the service finishes the write in hand, records
  it, and exits. A deploy in the middle of a pass loses nothing; the next
  pass picks up.
- **Logs.** `vm-logship` gets the new container name in its list.
- **Log lines.** A check that finds nothing prints nothing. A check or pass
  that did something ends with one line, `PASS OK` or `PASS FAILED`, with
  its kind and counts. Every five minutes the service prints `SYNC ALIVE`
  with the time of the last check of each kind. Those strings are an
  interface.
- **Alerts.** Two Azure alerts through the existing action group, the same
  way the email sidecar's work. One fires on `PASS FAILED`. One fires when
  no `SYNC ALIVE` has arrived in 15 minutes (20 was asked for, but Azure
  rejects a 20-minute window; see the step 5 design); it covers a stopped or
  restarting container, a hung process, and a break in log shipping itself.
  Open holds do not raise an alert. New holds are counted in the `PASS OK`
  line, and a full pass's line also gives the number open.
- **Rate limit.** An LGL check costs two requests, at most about 580 a day
  and fewer when idle, plus a few per write. The LGL client waits out `Retry-After`. Without that
  header it backs off 30, 60, 120 and 240 seconds, 450 in all, which
  outlasts LGL's five-minute pause. A network failure is retried the same
  way (step 5).
- **The details.** The step 5 design
  (`2026-11-14-lgl-vg-step5-service-and-deploy-design.md`) has the
  deployer's table of services, the two alerts and their queries, and the
  service's log lines.

## Build order

Each step is usable by itself.

**The steps are build stages, not releases.** Before go-live, every run is
attended: started by the engineer, or by an agent at the engineer's
direction, and its result checked. Runs are against a restored snapshot of
VG, and, for LGL writes, against the trial account and then printed calls.
After go-live, the scheduler runs the service unattended. The service goes to production once,
after step 7, with everything in place: the nightly full pass, both change
checks, and writes in both directions. The staged start in "Testing the
write paths" (an allow-list of test records, then a few real donors, then
everyone) happens within that one go-live, not as a series of releases. No
interim version, such as a nightly pass that writes only to VG, ever runs
unattended in production.

1. **Read and report.** The clients, the donor rule, cleaning, comparison
   and matching, with no writes and no memory. Run against a restored
   snapshot, it shows how many linked fields agree today, how many differ,
   and what matching would do. This needs only read access and is the
   evidence for the go-live question below.
2. **App work in `village-green`.** The role, the four tables, the endpoints
   including "what changed". The Keycloak client.
3. **Full pass, LGL to VG.** Memory, holds, writes to VG, last gift date,
   a decisions file. **Done 2026-11-13:** the harness's step 3 scenarios pass
   against the dev VG and the trial account (21 scenarios, the circuit
   breaker's among them). They replace the paused write run.
4. **Unlinked donors.** Linking and creating, and the one-time load of the
   import's decisions. **Done 2026-11-14:** 19 step 4 scenarios pass, and
   the full set of 38. Dry run on the production
   snapshot of 2026-11-14 with production LGL reads: the seed loaded 199
   holds (55 staff skips, 140 old last gifts, 4 import holds); the pass found
   199 unlinked donors, all of them seeded; 138 of the 140 old-gift holds
   kept the seed's fingerprint and stay dismissed, 2 became other holds
   because VG has gained a person matching them; no link, create or unlink
   (no new donor since the import).
5. **Scheduler and deploy tooling.** The long-lived service running a nightly
   full pass, writing to VG only. Also the CI image build, the generalized
   deployer, log shipping and the two alerts, rehearsed outside production.
   The production service is not started here. **Done 2026-11-15:** the
   full harness set passes with `--once full` (38 of 38). The image, run
   locally in Docker Compose, gave the start-up markers, a nightly pass at
   the set time and a clean stop. The deployer, run against a scratch
   compose file, deployed the second CI image (`carlsmig/vg-sync`), rolled
   it back on a forced gate failure, caught a real one (a wrong client
   secret), and left a compose file without `sync` alone. The step 5
   design, "What the rehearsal showed", has the details.
6. **Change checks.** The one-minute VG check, the five-minute LGL check
   including gifts, and their cursors.
7. **VG to LGL.** Writes to LGL, using the calls verified on 2026-11-11.
   Then the one go-live: the service is deployed to production and LGL
   writes are switched on in the stages above. Before its first production
   pass, `seed-import --write-vg` loads the import review's decisions into
   production VG (see "Staff decisions are not undone").

Two checks were set down here; one remains:

- ~~**Before step 5:** read the definition of the existing "email sidecar
  silent" alert in Azure.~~ Done 2026-11-14; the step 5 design, "The
  alerts", records it and the sync's alert built on it.
- **Before step 7:** send LGL a real, verifiable address on a test record
  and see whether address verification rewrites it. Partly answered on the
  trial account (2026-11-12 and 13): every verified address is rewritten
  within about eleven minutes, suffix abbreviated, and the city and ZIP can
  change too (see "On the trial account"). Still to map: units, directionals,
  and other suffixes. A rewrite that changes city or ZIP is copied to VG
  (Findings for the engineer, item d, settled).

## For the customer

The customer was given a sheet of seven decisions, each with a suggested
answer, on 2026-11-12. It also proposed a direction: VG as the main record
for names and contact details, LGL as the record for gifts. Staff answered
the same day.

| Question | Answer | Policy |
|---|---|---|
| 1. The same detail changed in both systems | Agree: VG wins, LGL's value logged | `both-changed`: `to-lgl` |
| 2. Addresses that differ today | Agree: VG's replaces LGL's, except PO boxes, which go to staff; LGL keeps the old one, not current | `address`, `never-agreed`: `to-lgl`; PO box guard |
| 3. Phones, emails and names that differ today | Agree: phones and emails from VG; a number only LGL has comes to VG; names listed, not changed; nothing in LGL deleted | `never-agreed` rows |
| 4. Deceased in one system | Agree: marked in the other, with the date; never removed by the service | `deceased` rows; guard |
| 5. Deleted or merged in LGL | Agree: never delete; follow a merge; a deleted donor loses the Donor mark in VG | `lgl-missing`: `unlink` |
| 6. Name changes, envelope name does not | Agree: rewrite addressee and salutation only if still LGL's default | `lgl-addressee`: `if-default` |
| 7. Couples | Shared-record names and deceased go to staff, one by one. That an LGL change goes to both people was not disputed, nor explicitly confirmed. | `couple-lgl-changed`: `to-vg` |

Still open with the customer:

- **How held items reach staff**, and who receives them. See "Telling
  staff".
- **Question 7's first half**, if anyone objects.

Not asked, and held by default: a value cleared in either system, and a
linked donor who no longer passes the donor rule (`no-longer-donor`).

Context for the engineer: staff corrected a number of people in VG during
the 2026-11-05 review on the understanding that LGL would be brought into
line later, so for those people VG holds the newer value. The answers to
questions 2 and 3 do that.

## Findings for the engineer

Found while building the harness (2026-11-13). All four were settled by the
engineer on 2026-11-14.

- **The app's dismissal text overstates permanence.** The app's OpenAPI
  text for `POST /sync/holds/{holdId}/dismissal` says "A staff dismissal is
  permanent". This design has two rules: a dismissed field hold stays
  dismissed only until either value changes ("Holds on fields"), which the
  sync does and the harness checks; a staff decision seeded from the import
  is permanent ("Staff decisions are not undone"), which nothing loads yet.
  The app's code allows `dismissed` to `open` for any dismissal kind, so only
  its text needs to change. Noted on the board item (2026-11-14).
- **Unclean values share one fingerprint. Settled 2026-11-14: reopen.** An
  unclean LGL value's comparable form is `''`, so the fingerprint was the
  same for every unclean value, and the hold's detail showed LGL as empty.
  The engineer ruled that a new malformed value reopens a dismissed hold. The
  fingerprint and detail now use LGL's raw value (Guards, Unclean); the
  harness scenario `unclean-lgl-city-after-agreement-is-held-unclean-reopens-on-new-malformed-value`
  shows it live.
- **A never-agreed unclean email hid itself. Settled 2026-11-14: malformed
  takes priority.** When LGL's email was unclean, VG's empty and the pair
  had never agreed, the hold was `never-agreed`. It is now `unclean`, with
  the case in the detail. A unit test covers it; the trial account can't
  produce it, because LGL's API stores a malformed email as not current,
  which the sync ignores. A related effect of the guard fix: an open
  `unclean` hold on a case whose action goes `to-lgl` closes on the next
  pass, which is intended.
- **(d) A verification rewrite changes VG's town or ZIP. Settled
  2026-11-14: accept it.** LGL's sweep can change an address's city or ZIP
  (see "On the trial account"). The next LGL check sees it as
  `lgl-changed`, and policy copies it to VG. The engineer ruled this is not
  a problem: a rewrite to the proper post office town and ZIP is what VG
  should hold. The customer has no expectation that a member's town matches
  their village's name. LGL's dedup and address verification stay on; the
  engineer considered turning them off and kept them, since the design
  already works around both.

## Left to the builder

- The exact request and response shapes of the sync endpoints.
- The comparable-form rules in detail, starting from `lgl-import/count.js`
  and `src/person.js`.
- ~~Whether a merge in LGL can be detected.~~ Settled 2026-11-14: it cannot,
  and need not be. A hand merge on the trial account left the merged-away id
  answering 404 and no trace of it on the kept record, so a merge is a
  deletion to the sync and the survivor is followed when matching finds it
  (see "Gone from LGL"). The harness's simulation of a merge with a delete is
  therefore faithful. LGL's unmerge is untested.
- The values of the limits (circuit breaker, constituent-count drop,
  flapping).
