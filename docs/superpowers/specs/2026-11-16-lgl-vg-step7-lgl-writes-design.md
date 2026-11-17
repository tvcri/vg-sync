# LGL ↔ VG sync, step 7: writes to LGL

2026-11-16. Status: built; rehearsed 2026-11-16 (see "What the rehearsal showed"). Board item
VG-202611-521 (#153 in `tvcri/village-green`).

The sync design (`2026-11-11-lgl-vg-sync-design.md`) is the parent. This
document covers its build step 7 and does not repeat it. Where this document
makes a new engineering call it is marked **(call)**; where the engineer
decided in conversation it says so.

## Intent

Through step 6 the service decides what VG's edits mean for LGL and only
records them: every `to-lgl` action is `deferred`. Step 7 makes those
decisions into LGL writes, so a correction made in VG reaches LGL within
minutes, and the differences that already exist at go-live are resolved as
the customer answered (VG wins; addresses, emails and phones from VG). Then
the one go-live.

LGL keeps no history of API writes, so every LGL write is recorded in VG's
`sync_log`, which is the only record of what the sync changed there.

## Goals

- Every decision that is `deferred` today becomes an LGL write, from the
  full pass and both checks, when LGL writing is on.
- A write never overwrites an LGL edit the plan did not see.
- A write never adds an entry LGL already has, and never removes one.
- A name copied to LGL rebuilds LGL's addressee and salutation only when
  they are still LGL's default for the old name; otherwise staff are told.
- Every LGL call sent is in `sync_log` with LGL's old value.
- The sync's own writes, and LGL's rewrites of them, settle: they come back
  through the LGL check as `same` and are not written again.
- Dry by default. LGL writing is a switch, and limited by an allow-list.

## Non-goals

- How held items reach staff (still open with the customer; holds stay in
  `sync_hold`).
- The VG → Mailchimp executable.
- Signed-JWT sign-in for the service (deferred by the engineer).
- A note in LGL for each change (possible, not asked).

## Anti-goals

From the sync design, those step 7 can now break:

- Creating or deleting a constituent in LGL. The service's LGL client has no
  call for either.
- Overwriting a deliberate value with a stale one.
- Deleting anything in LGL: an entry replaced is marked not current, never
  removed.
- A write loop: the sync and LGL's verification rewriting each other's value.

## What was verified (trial account, 2026-11-16)

Scripts: `harness/discover-names.js`, `harness/discover-entries.js`. Every
record they create is deleted before they exit. The trial account's settings
match production's, including Constituent Names (the engineer, 2026-11-16):
salutation Informal, addressee Formal, prefix and suffix fields off, spouse
in salutation off.

**Addressee and salutation.**

| New constituent | Addressee | Salutation |
|---|---|---|
| first, last | First Last | First |
| with a middle name | First Last | First |
| with a nickname | First Last | First |
| with suffix "Jr." | First Last Jr | First |
| with prefix "Dr." (API) | Dr. First Last | First |
| first name "Pat and Lee" | Pat and Lee Last | Pat and Lee |

- A PATCH of the first name alone leaves both as they were.
- **A PATCH that sends `addressee` and `salutation` as `""` (or `null`) makes
  LGL build them again from the current name and the account's settings.**
- A PATCH that sends values stores them as sent.

So the service never composes an addressee. It only has to recognize LGL's
default for the old name: addressee `[prefix ]first last[ suffix]`, the
suffix with trailing periods dropped, single spaces; salutation `first`.

**Entries: addresses, emails and phones behave the same.**

- An entry added with `is_preferred: true` becomes preferred, and **LGL
  clears `is_preferred` on the entry that was preferred.** One call, not two.
- `PATCH {not_current: true}` works on all three kinds.
- `PATCH {not_current: false, is_preferred: true}` revives an entry and
  clears the other entry's preferred mark.
- Every one of these moves the constituent's `updated_at`.
- **A constituent has one preferred phone, not one per type**
  (`discover-entries.js --phone-types`). Adding a Mobile as preferred
  cleared the Home entry's mark, and a Home added as preferred then cleared
  the Mobile's. The sync reads `phone` as the preferred non-mobile entry and
  `cell` as the preferred mobile one, falling back to the only current entry
  of the type (`fields.js`), so only one of the two is ever preferred. See
  "Phones" below.

**Verification of units and directionals** (six public landmark addresses,
kept outside the repo). The sweep came about 5 minutes after the write.

- Directionals and ordinals are abbreviated (south → S, northwest → NW,
  fifth → 5th). The comparable form already does the same: compares `same`.
- A unit on a second line is joined to the street line, and "suite" and
  "#" both became "Ste" with the building's own designator. Compares
  `same`.
- **"apartment 5" became "Fl 5"**: verification replaced the designator with
  the building's. The comparable form drops only apt, apartment, unit,
  suite and ste, so this compares as a change. **Step 7 fixes it**: every
  USPS secondary unit designator (Publication 28, Appendix C2: apt, bldg,
  dept, fl, frnt, hngr, key, lbby, lot, lowr, ofc, ph, pier, rear, rm, side,
  slip, spc, stop, ste, trlr, unit, uppr, and their spelled-out forms) is
  dropped before a designator, so a rewrite of the designator alone
  compares `same`.
- ZIP+4 is added (the comparable form keeps five digits).

## Approaches

The calls to LGL are settled. The question was where in the service they
are sent.

- **A. A second apply step on the same plan (chosen, the engineer
  2026-11-16).** Where a decision is `deferred` today, the plan holds an LGL
  write instead. A new module, the LGL counterpart of `apply.js`, re-reads
  each constituent, sends the calls still wanted, logs them and records the
  memory. The full pass and both checks use it.
- B. A queue: decisions written to a table, a separate worker sends them.
  Rejected: it needs an app migration and adds state that can drift between
  decision and send, for nothing A lacks.
- C. Writes from the VG check only. Rejected: the differences that exist at
  go-live never pass through a check, and only a full pass would resolve
  them.

## The write path

### Planning

`plan.js` changes only where it says `deferred` today:

| Today | Step 7 |
|---|---|
| `to-lgl` | an LGL write of VG's value |
| `to-lgl-else-hold`, VG not empty | an LGL write of VG's value |
| `toward-deceased`, VG deceased and LGL not | an LGL write of the mark and date |
| `merge`, numbers only VG has | an LGL write adding those numbers |

The new guards run in the plan, before a write is planned, and each makes a
hold:

- **PO box** (sync design, Guards; customer question 2). An address write
  that would replace a PO box as LGL's preferred address is held, reason
  `po-box`. LGL's address is a PO box when its street matches `PO_BOX` in
  `clean.js`.
- **Hand-written addressee.** A write that changes the first name, last name
  or suffix, when LGL's `addressee` or `salutation` is not the default for
  LGL's current name (above). The name is still written; the addressee and
  salutation are left alone; a hold opens, reason `addressee`, so staff can
  fix the envelope. **(call)** Writing the name and holding the envelope,
  rather than holding the name, follows question 6 ("rewrite them only if
  still the default; otherwise leave them and list the record").
  **(call)** `policy.js` does not check settings today; step 7 checks
  `lgl-addressee` at load, with two values: `if-default` (as shipped, the
  rule above) and `never` (every name write leaves them, and opens no
  hold). Any other value refuses to load, as an unknown action does.
- **Flapping** (sync design, Guards). A field written to LGL more than three
  times in thirty days for the same person is held, reason `flapping`.
  **(call)** The count comes from `sync_log` (rows with outcome `written` for
  the person and field), read once per run for the people the plan would
  write. Every round trip between the systems includes an LGL write, so LGL
  writes alone show a flap; the VG half needs no history.

Couples (sync design, Couples): **(call, completes the design)** a shared
field (address, email, phones) is written to LGL only when every partner's
case is `vg-changed` or `both-changed` and all partners hold the same
comparable value; it is written once. Otherwise the existing `couple` hold.
Names and deceased are never written for a couple.

Each LGL write in the plan carries: constituent id, person id, field, case,
VG's value (cleaned), and LGL's comparable value as the plan saw it (the
stale check's expectation).

### Applying

A new module, `apply-lgl.js`. For each constituent with LGL writes, in turn:

1. **Read it fresh** (`GET /constituents/{id}` and its three lists, as
   `lgl.getConstituent` does in a check). A 404 skips it; the next full pass
   sees it missing.
2. **Stale check.** For each planned field, LGL's comparable value must
   equal the plan's. If it moved, the field is skipped, outcome `stale`, and
   the next check decides again. This is what makes a decision from the
   check's LGL cache (more than 20 touched) safe. **(call, final review)**
   An unclean LGL value (comparable form empty) is compared as LGL stored it
   (`lglExpect`, shared by the plan and the apply step), so an edit from one
   unclean value to another, or of the clean phone slot beside an unclean
   one, is stale too.
3. **Build the calls** from the fresh record (next section).
4. **Send them**, in order. Dry: print them, send nothing.
5. **Log** the constituent's calls to `sync_log` in one append, right after
   its calls. If the append fails the run fails: a write must not go
   unrecorded. **(call)** A crash between sending and logging loses that
   constituent's log rows; the memory is not written either, so the next run
   reads LGL, finds the field `same` or `converged`, and records it. The gap
   is in the log only, and is accepted.
6. **Memory.** For each field whose calls all succeeded, an agreed row with
   VG's value and the LGL entry id written or reused.

**(call, final review)** A run that fails (a non-refusal failure, below)
still keeps what it gathered: the failed constituent's calls are logged
first, then `apply.js` upserts the memory gathered so far and opens the new
holds (an `addressee` or `lgl-incomplete` hold is never found again by a
later plan), closing and reopening nothing, as a stopped run does; then the
run fails with the original error. If that log append also fails, the
error's message says so and how many calls went unlogged, so the PASS FAILED
or CHECK FAILED line carries it.

**(call, final review)** Two writes to the same constituent and field in one
run (a customer policy could produce them; both would add the same entry)
fail the run before anything is sent.

Then the existing `apply.js` order holds: VG writes, then LGL writes, then
memory and holds for the run. A value is never written both ways in one
run. **(call)** `merge` (never-agreed phones) is the one field written both
ways: LGL's numbers fill VG's empty slots and VG's numbers LGL lacks are
added to LGL, different numbers in each direction. A `merge` records no
memory row; the next run reads both sides, finds them `first-match` if they
now agree, and records it there. A merge that leaves them differing (a
number with no slot) stays `never-agreed` with its `phones-no-slot` hold, as
today.

**Refusals.** A 400, 404 or 422 on a call stops that field's remaining
calls, logs the call with outcome `refused`, and opens a hold, reason
`lgl-refused`, with LGL's message. Any other failure fails the run, as for
VG. **(call, final review)** That failed call is logged with outcome
`failed`, since LGL may have applied it; and if an earlier call of the same
field was answered (an add went through, then its retire failed), the field
is left part way and an `lgl-incomplete` hold is opened. **(call)** The hold's fingerprint is the write attempted (field and
VG's comparable value), not the three values the plan saw, because a
partial write can change LGL's value. While an open or dismissed
`lgl-refused` hold has the same fingerprint, the plan does not try that
write again; a new VG value is a new fingerprint and is tried.

### Holds

| Reason | Opened | Closed |
|---|---|---|
| `po-box` | by the plan while the write would replace a PO box | by reconciliation when no longer wanted (owned) |
| `flapping` | by the plan while the count is over the limit | owned, as above: it closes when the thirty days have passed |
| `lgl-refused` | by the apply step, on a refusal | owned, like `vg-refused`: closes when the plan no longer makes that write |
| `addressee` | by the apply step, when it writes a name and leaves a hand-written addressee | **(call)** not owned: only staff close it, by dismissing it |
| `lgl-incomplete` | **(call, final review)** by the apply step, when a field's calls stop part way on a failure; detail names the calls sent, the call that failed and the entry left current (`oldEntryId`); fingerprint the field and value written | not owned: staff retire the old entry in LGL by hand and dismiss it |

**(call)** `addressee` is a to-do for staff ("this envelope still has the
old name"), not a state the sync can watch: the name compares `same` on the
next run, and nothing tells the sync when staff have fixed the envelope. So
it is opened once, when the name is written, and the sync never closes or
reopens it. Its fingerprint is the name written.

**Retries. (call)** A PATCH is retried as reads are (full pass: five
attempts with backoff; check: one attempt). A POST that fails without a
response (network error, timeout) is not retried: it may have been
applied. The run fails; the next run's fresh read finds the entry and
reuses it.

**Stop.** Checked between constituents. The constituent in hand finishes
its calls and its log append.

### The calls

Names and deceased: one `PATCH /constituents/{id}` with only the changed
keys (`first_name`, `last_name`, `suffix`, `nick_name`, `is_deceased`,
`deceased_date`). When the addressee rule allows it, the same PATCH carries
`addressee: ""` and `salutation: ""`. A deceased mark is never removed (the
existing guard).

**(call)** The first name sent is VG's with any "(Nick)" part removed, since
the comparison sets that part aside; VG's nickname goes to `nick_name`.

Address, email, phone, cell: one value, VG's, becomes LGL's preferred
current entry of its kind.

1. **Find it.** An entry of the kind (for phones, of the same type group,
   mobile or not) whose comparable value equals VG's, current or not. If
   found, `PATCH /<kind>/{id} {not_current: false, is_preferred: true}`.
   Otherwise `POST /constituents/{id}/<kind>` with the value,
   `is_preferred: true` and a type (`Home`; `Mobile` for `cell`). Phones
   differ on the preferred mark; see "Phones".
2. **Check it took.** LGL stores a malformed email as not current with a
   200. The new or revived entry's `not_current` (from the response, or a
   read of the list if the response lacks it) must be false. If not, the
   old entry is not retired, the field gets an `lgl-refused` hold, and LGL
   keeps a current email. **(call)** Checked before step 3 so a refusal
   never leaves the constituent with nothing current. Done for all kinds,
   not only emails: it costs nothing when the response carries it.
3. **Retire the old one.** The entry the sync read as LGL's value (its
   preferred, or only current, entry of the kind or type group), if any and
   if different, gets `PATCH {not_current: true}`. **(call)** Only that
   entry: other current entries (a Work number, a second Home number) were
   never compared and are never touched.

An address is sent as cleaned VG values: `street` is VG's street, and VG's
unit on a second line; `city`; `state` as its two-letter code;
`postal_code` as VG's ZIP.

**Phones.** `phones` compares as a set of numbers, read from two slots:
`phone` (non-mobile) and `cell` (mobile). A write handles each slot whose
number differs: VG's number is found or added in that type group, and the
entry the sync read for that slot is retired. In `merge`, nothing is
retired: LGL's numbers came to VG. **(call)** Because LGL has one preferred
phone per constituent, a phone write never moves the preferred mark to
another type group: the new entry is sent `is_preferred: true` only when the
entry it replaces held the mark, or when no current phone holds it.
Otherwise it is sent `is_preferred: false`, and is read as its slot's value
because it is the only current entry of its type group. This keeps a write
from making the other slot ambiguous (two current entries, the mark on
neither). A slot that already has two current entries and no mark is
`ambiguous` today and is held before any write.

### The log

One `sync_log` row per call: run id, constituent id, person id, field,
case, the request (method, path, body), the LGL entry id, LGL's old value
(the field as read fresh), the new value, outcome (`written`, `refused`,
or **(call, final review)** `failed`: a call that failed without a refusal,
logged because LGL may have applied it; the flapping count reads `written`
only) and response status. Stale fields are counted, not logged: nothing was sent.

### What comes back

- **The write itself.** It moves `updated_at`, so the next LGL check
  touches the constituent. LGL now equals the agreed value: `same`, nothing
  written, and nothing reported, since `same` is not a change. The step 6
  open item "check that a write to LGL comes back only once" becomes a
  harness scenario.
- **Verification** moves `updated_at` again 5 to 11 minutes later. A rewrite
  of form compares `same` (with the unit fix). A rewrite of city or ZIP is
  `lgl-changed`, copied to VG (finding (d), settled), then `same` both ways.
- **The daily dedup job** deletes entries without moving `updated_at`; only
  the full pass sees it, and finding entries by value means a missing id is
  never a failure.

## Switches and limits

- `--write-lgl` on `--once full`, `--once vg-check`, `--once lgl-check`;
  `WRITE_LGL=true` for the scheduler. Off by default. Without it, LGL writes
  are printed in the decisions file and the output and counted as
  `deferred`, as today. **(call)** `--write-lgl` requires `--write-vg`
  (and `WRITE_LGL` requires `WRITE_VG`): the log, the memory, the holds and
  the run row are all VG writes.
- `LGL_WRITE_ALLOW`: a comma-separated list of constituent ids, or `all`.
  Empty or unset means none: with `--write-lgl` and no allow-list nothing is
  written. A write to a constituent not on the list is `deferred`, note
  `not-allowed`. **(call)** Empty means none, not all, so turning writing on
  never writes to everyone by accident.
- The run row's `switches` gain the real `writeLgl`, and its counts gain
  LGL writes, stale and refused.
- **Circuit breakers.** A person with an LGL write that will be sent
  (switch on, constituent allowed) counts toward the full pass's
  people-changed limit and the check breaker, like a VG write. **(call)**
  Writes that will not be sent do not count, so go-live stage 2 (printed
  only) trips nothing it would not trip today. The backlog at stage 4 is
  expected to exceed the limit; that pass is run by hand (below).
- `PASS OK` and `CHECK OK` lines gain `lgl-writes=`, `lgl-stale=` and
  `lgl-refused=`; `deferred=` stays and counts only what was not sent.
- **Rate limit.** A field write is 1 to 3 calls plus the constituent re-read
  (4 requests). The first full pass at go-live resolves the existing
  differences, a few hundred requests; the client waits out LGL's 429s and
  the allow-list stages it.

## Testing

**Unit tests** for the plan rows, the guards, the call builder (find,
reuse, add, retire; the addressee rule), the stale check, refusals,
the no-retry POST, the log rows, the switches and the allow-list.

**The harness is the main proof.** It already seeds the trial account,
runs the real service and reads LGL back (`expect.lgl`). Its runs gain
`--write-lgl` with `LGL_WRITE_ALLOW=all` in `.env.harness`.

- The scenarios that expected `deferred` change to expect LGL's value
  after the run: `vg-email-change-after-agreement-reaches-lgl` (was
  `vg-email-change-after-agreement-is-deferred`),
  `unclean-lgl-city-never-agreed-goes-to-lgl`,
  `lgl-only-phone-fills-empty-vg-slot` and `vg-edit-reaches-lgl-by-vg-check`
  (was `vg-edit-is-deferred-by-vg-check`). Two scenarios were renamed, as
  shown. `check-leaves-untouched-hold-open` is not a flip: it gained
  `lglWrites: 0, deferred: 0`, and its held first name is never-agreed, which
  is never held (it is a both-changed pair, and the write goes to LGL).
- New scenarios: VG wins a conflict (`both-changed`) with LGL's old value in
  the log; never-agreed address replaced, old entry not current; VG's
  address already on file as a not-current entry is revived, not added; PO
  box held; deceased marked in LGL with its date; a name write that rebuilds
  the addressee and salutation; a hand-written addressee left and held; a
  couple whose partners both changed the same; a couple where one changed
  (held); an email LGL stores as not current (held, the old email still
  current); a Home and a Mobile number both written (neither slot ambiguous
  after); a Work number LGL holds beside the Home number (not retired); the write comes back through the LGL check as `same`
  and is not written again; LGL edited between plan and write (stale);
  flapping held; the allow-list (a constituent not on it is deferred).
- A verification rewrite after a write cannot be waited for in a scenario
  (5 to 11 minutes); the unit-designator fix rests on unit tests built from
  the rewrites seen above.

**Dry run against production LGL** with a restored production snapshot in
the dev VG: every printed call is reviewed against the record in the LGL
screen for a sample, and the counts against the 2026-11-11 report.

## Go-live

**(the engineer, 2026-11-16)** The sync design's first stage, invented test
records in production LGL, is dropped. Invented records test nothing the
trial account has not; what production adds is real data shapes, which
only real records have. The go-live is:

1. The step 5 go-live tasks for the engineer (VM, compose, alerts), and
   `seed-import --write-vg` into production VG.
2. The service starts with `WRITE_LGL=true` and an empty allow-list: VG
   writes on, LGL writes printed and counted. A full LGL snapshot is saved.
   The first passes' printed calls are reviewed.
3. **A handful of real donors** on the allow-list, picked to cover the risky
   shapes: a never-agreed address, a PO box, a hand-written addressee, a
   name change, a couple, a phone and a cell. Each is checked by hand in LGL
   afterwards, including the verification rewrite.
4. **The backlog, by hand:** a dry `--once full` with the allow-list at
   `all` prints every call; once reviewed, `--once full --write-vg
   --write-lgl --max-people <n>` with `n` from the write run's own breaker
   message (see "Rulings during the build"). Then
   `LGL_WRITE_ALLOW=all` in the service's `.env`. **(call)** No special
   allowance in the code: the breaker stays the same for every unattended
   run, and the one big pass is attended.

Each production LGL write stage needs the engineer's go-ahead.

## What the rehearsal showed (2026-11-16)

A production backup of 2026-11-16 was restored into the dev VG, the service
account's grant restored, and `LGL_WRITE_ALLOW=all node src/lgl-vg/main.js
--once full --out out/step7-dry` run with no `--write-*` against production
LGL (reads only). Counts only; the decisions file holds the real data.

1. **Unit tests** pass (717).
2. **The harness:** 59 passed, 0 failed, 1 known, in about 25 minutes, with
   the 16 new step 7 scenarios in `harness/scenarios/to-lgl.js`.
3. **The dry full pass** exited 0: `PASS OK full dry-run people=31 writes=31
   deferred=232 holdsPlanned=344 lgl-writes=0`. Production has never run the
   sync, so it has no memory and every LGL write is never-agreed.
4. **LGL writes planned** (all deferred, note `write-lgl off`): 232 fields on
   194 constituents, in 322 calls. No deferred write lacked calls; there were
   no `no calls` skips and no `vg state not a code`.
   - phones: 136 fields, 138 add calls (VG-only numbers added, sent not
     preferred; LGL keeps its preferred phone);
   - email: 52 fields, 21 adds, 31 revives (VG's email already on file in
     LGL) and 47 retires;
   - address: 43 fields, 24 adds, 19 revives and 41 retires, every state sent
     as a two-letter code;
   - deceased: 1 set.
5. **Against the 2026-11-11 report:** it found about 40 never-agreed
   addresses and 5 PO boxes; the rehearsal planned 43 address writes and held
   5 as `po-box`. They match.
6. **Holds planned** (selected): po-box 5, phones-no-slot 25, couple 10,
   unclean 5, ambiguous 1, never-agreed 99. `holdsOpen=0`, since production
   VG has no seeded holds yet; `seed-import` loads them before go-live.
7. **VG writes planned:** phones 27, last gift date 3, one link.
8. **Consequence for go-live:** the backlog pass changes about 194 people
   for LGL plus 31 for VG, far over the 50-person breaker. It is run by
   hand, with `--max-people` from the write run's own breaker message
   (see Go-live stage 4).

## Rulings during the build

Controller rulings made while building, which change or sharpen the design.

- **POST retries.** A POST is retried on 429 only. A 5xx can follow an
  applied POST, so it is not retried (a retry could add an entry LGL already
  has); the next run finds the entry by value. A network error or timeout is
  never retried, as before.
- **`listEntries` refuses a truncated list.** It throws when `total_items`
  exceeds the items read: the call builder must see every entry to find by
  value without adding a duplicate. More than 100 entries of one kind is a
  permanent read failure for that constituent (none expected).
- **Unclean values are repaired.** `lglFields` records `entryIds` for the
  picked entry even when its value is unclean, and each phone slot is compared
  against that slot's read entry, so a repair retires exactly the entry the
  sync read.
- **Merge phones.** A VG-only number is written to LGL only into a type group
  (mobile, non-mobile) with no current LGL entry; otherwise it is left, and
  the `phones-no-slot` hold already lists the disagreement. The write never
  creates an ambiguous slot.
- **`vg-cleared`.** A non-merge phones write where VG emptied a slot LGL
  still holds is held `vg-cleared` in the plan. Clearing is held both ways.
- **State is a two-letter code.** VG's state goes through `stateCode` for the
  write, and `comparable('address')` reduces state the same way, so VG
  "Rhode Island" against LGL "RI" reads as the same instead of looping to
  flapping. A state that does not convert throws only for a write that will
  be sent; a deferred write keeps going, with its calls omitted and the note
  `vg state not a code`, so a dry run or a writing-off run never fails on data
  it will not send.
- **`no calls`.** When an LGL write yields no calls on a non-merge path, the
  decision is a `skip` with note `no calls`, not a change and not silent.
- **A retire answered 404 is done.** The entry is already gone (for example
  LGL's dedup); it is logged with status 404 and the field is still written.
  A missing id is never a failure.
- **A sent add is logged before its check.** An add or revive is logged
  before the read-back check, so a sent POST is never unlogged. An add whose
  check read failed is logged `written` with the note `not checked`.
- **Flapping counts distinct runs.** One write logs one row per call, so the
  count is distinct `runId` per person and field among `written` rows.
- **5000 rows is a final failure.** Reaching 5000 written log rows in 30 days
  fails the run without writing. Expected volume is a few hundred rows even at
  go-live; 5000 means a loop, so halting and alerting is right.
- **A VG check that would send LGL writes during an LGL rate-limit pause**
  fails before writing. Checks by hand use 5 attempts; the service's checks 1.
- **Go-live `--max-people`.** Its `n` comes from the write run's own breaker
  message: the run trips safely, reports the true count and writes nothing.
  One extra attended command (call).

## Left to the builder

- The exact shape of an LGL write in the plan and of the call builder's
  output.
- Where the fresh constituent read lives (`lgl.getConstituent` exists for
  checks).
- Reading `sync_log` for the flapping count (`GET /sync/log` takes
  `personId`, `since`, `outcome`).
- The decisions-file form of a printed call (the sync design's example:
  `LGL PATCH /street_addresses/<id> {"street": "..."}`).
- Which harness scenarios share a reseed.
