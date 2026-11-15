# vg-sync test harness: design

2026-11-13. Companion to `2026-11-11-lgl-vg-sync-design.md` (the sync
design), which stays the authority on what the sync does. This document is
about how that behavior is tested end to end, against invented data in the
two systems the sync connects.

## Intent

Every behavior the sync design describes, and every customer answer, should
be provable by a run that anyone can repeat, without real data. Today the
evidence is unit tests on pure code and dry runs against a restored
production snapshot. The snapshot is real people, so its output has to be
masked, and it contains only the cases that happen to exist. It cannot show
"both sides changed", "a deceased mark was removed in LGL", or a write to
LGL at all.

The harness puts invented people into the local dev VG database and into
the LGL trial account, links them as the sync would, plays a scripted
sequence of edits and passes, and checks what each system and the sync's
tables hold afterwards. Agents run it freely while building steps 3 to 7
(see the run rule in `CLAUDE.md`), with no real data passing through their
context.

## Goals

- **One scenario per behavior.** Each case, guard and customer answer in the
  sync design has a scenario that sets it up, runs it, and checks the result.
- **The real service code.** Scenarios run the same `full` command (and,
  from step 6, the same checks) that production will run, with an
  environment file pointing it at the dev database and the trial account.
- **Both directions.** From step 7, LGL writes go to the trial account and
  are read back, not just printed.
- **Repeatable from nothing.** A reseed rebuilds both systems, so a new trial
  account (the current one lasts about three months) needs no hand work
  beyond the one-time setup below.
- **A plain result.** Each scenario passes or fails with the field, the
  expected value and the value found.

## Non-goals

- Replacing the unit tests. Pure logic is still tested in `npm test`; the
  harness proves the pieces work together against the real APIs.
- Replacing the production snapshot. Real data is messier than anything
  invented. Each build step still ends with a dry run against a restored
  snapshot and production LGL reads, as before.
- Load or rate-limit testing.
- Testing LGL's own behavior beyond what the sync depends on. The `spike/`
  experiments stay where they are.

## Anti-goals

- **The harness must never reach production.** It deletes and rewrites
  freely. It refuses to start unless both targets are proven to be the test
  ones (see "Guards").
- **The sync code must not learn about the harness.** No test switches in
  `src/lgl-vg/`. The service is pointed at the test systems by its
  environment file, nothing else. **(call)** `main.js` gets one general
  option, `--env <file>` (default `.env`), which replaces the hard-coded
  `.env`. It is ordinary configuration, as in `spike/`, not a test switch. This keeps the earlier decision that the
  service knows nothing about the trial account.
- **No real data in scenarios.** The repo is public; scenarios are invented
  (Jane Doe), and so is everything they produce.

## The two systems

| | VG | LGL |
|---|---|---|
| Target | Local dev database, `village-green-orch-db-1` (port 60001), API at `http://localhost:64001/api` | Trial account `tvcritest`, key in `.env.trial` |
| Background population | The demo generator with donors off: 301 invented people, 10 villages (village-green PR #156) | None beyond the harness's own records and the sentinel |
| Scenario records | Persons created by the harness, with donor rows linking them | Constituents, their entries and gifts, created by the harness |
| Left alone | The demo stack (`village-green-demo-*`, port 60002) | The hand-made sentinel record and the `spike/` probe records |

The records the harness leaves alone in LGL are still pulled by every pass.
None has a gift, so none is a donor, and the sync ignores non-donors at
every step. The guard checks this: a non-harness constituent with a gift
stops the run.

The generator's population matters: its people give the matching in step 4
realistic look-alikes, and they are non-donors the full pass must ignore.

## Setup, once per environment

Done by an agent where it can, or handed back to the engineer where it needs
a screen:

1. **The dev database at the current schema** (migration 0033 or later),
   with the API running from `main`.
2. **A second Keycloak client** in the dev realm, `vg-sync-harness`, with
   client credentials. The reseed grants it Admin in the dev database each
   time (see "The runner"). The harness uses it
   to make edits as staff would, so they land in `audit_event` the way a
   staff edit does. The service keeps its own `vg-sync` client and role 8.
   **(call)** A separate client, not the service's: an edit made by the
   service's own account would look like the service's own write.
3. **The trial account's funds and payment type.** The donor rule ignores
   gifts in the membership fund paid by PayPal. The trial account needs a
   fund to play the membership fund and a payment type to play PayPal. The
   API creates funds, so `harness/discover.js --write` makes two,
   "Harness Membership" and "Harness General" (for ordinary gifts), and
   prints their ids. It cannot create payment types, so the account's
   existing Credit Card type stands in for PayPal, and ordinary scenario
   gifts are paid by Check or Cash. Nothing is made in the LGL screen. The
   ids go in `.env.harness`.
4. **`.env.harness`**, gitignored: the trial `LGL_API_KEY`, the trial fund
   and payment type ids, the dev VG URLs, the `vg-sync` client for the
   service, the `vg-sync-harness` client for the harness, and the database
   connection for reseeding. `.env.harness.example` is committed with names
   only.

## Guards

The harness checks both targets before it reads or writes anything, and
stops with a message naming the check that failed:

- **LGL:** the key reaches an account with fewer than 200 constituents that
  contains the sentinel record (the same check `spike/lgl-trial.mjs` makes).
- **VG:** the API and auth URLs are local (`localhost`, `127.0.0.1`, `::1`)
  and use the dev stack's ports only (API 64001, auth 8090); the demo stack's
  endpoints (API 54000 and 64003, auth 8091) are refused. `HARNESS_DB_HOST`
  is empty or local, `HARNESS_DB_PORT` is not the demo database's (60002),
  and `HARNESS_DB_CONTAINER` does not name the demo stack (compared trimmed
  and case-insensitively). A whitespace-only value counts as empty.
- **The service's environment:** the harness runs the service only with
  `--env .env.harness`, and checks that file's LGL key and VG URL pass the
  same two checks. The runner also starts the service with every variable
  named in `.env.harness.example` removed from its inherited environment,
  because the file loader does not override variables already set: a
  production key exported in the shell must never win over `.env.harness`.

Every record the harness creates is marked so it can be found again: in LGL
by a harness tag in the constituent's external id field, or failing that a
fixed note; in VG by the donor link's constituent id, which only the harness
writes in the dev database. The LGL marker is settled: see "Left to the
builder".

## Scenarios

A scenario is one person, or one couple, and the story of what happens to
them. Scenarios live in `harness/scenarios/`, one file per area (names,
addresses, phones, emails, deceased, couples, donors and gifts, holds,
records), as plain data in ES modules, so a comment can say why the case
exists.

```js
export default [
  {
    name: 'lgl-only-phone-fills-empty-vg-slot',
    why: 'Question 3: a number only LGL has is copied to VG.',
    since: 3,                       // the build step that makes it pass
    vg:  { firstName: 'Jane', lastName: 'Doe', phone: null, cell: '401-555-0101' },
    lgl: { first_name: 'Jane', last_name: 'Doe', phones: [{ number: '401-555-0102', type: 'Home' }] },
    gifts: [{ date: '-60d', amount: 50 }],
    phases: [
      { run: 'full', expect: {
          vg:  { phone: '401-555-0102', cell: '401-555-0101' },
          holds: [],
      } },
      { run: 'full', expect: { writes: 0 } },
    ],
  },
]
```

- **`vg` and `lgl`** are the starting records, in each system's own shape,
  so a scenario can start them disagreeing in any way.
- **`gifts`** decide whether the constituent is a donor and its last gift
  date. A scenario can include a dues gift (membership fund, and the payment
  type standing in for PayPal) to check it is ignored.
- **`link`** is true by default: the harness creates the VG donor row
  pointing at the new constituent. False for the unlinked-donor scenarios of
  step 4.
- **`couple`** gives two VG people and one LGL record.
- **`phases`** run in order. Each may first `edit` either system (as staff
  would, through each system's API; `edit.vg.lastGiftDate` sets the donor
  row's date, for a scenario that needs VG to start with an old one),
  `wait` (see "LGL's own jobs"), then `run` a pass (`'full'`, or from
  step 6 one change check, `'lgl-check'` or `'vg-check'`, run by hand as
  `--once <run>`), then `expect`. A check reads the cursor its scenario's
  own earlier full pass set, so a check phase is allowed only in a
  `runAlone` scenario. A check that found nothing writes no decisions file,
  which reads as no decisions. A phase's `args` (extra command-line options for the
  pass, such as `--max-people 1`) are allowed only in a `runAlone` scenario.
- **`runAlone`** scenarios do not join the lockstep. Each gets its own
  reseed of the whole VG and only its own LGL records, and its own passes,
  after the lockstep group. `runAlone` may instead be a group name: the
  scenarios that share it get one reseed and run in lockstep with each
  other only (step 6's "a hold on a pair the check did not touch" needs two
  pairs). They must name the same `run` for each phase.
- **`known`**, on a scenario or a phase, marks a failure that is a finding
  for the engineer and not a regression. A scenario that fails only in known
  phases reports `KNOWN` with its note, and does not fail the run. A known
  phase that passes says so. None is marked today.
- **`expect`** is partial: only what it names is checked. VG and LGL values
  are compared in the sync's comparable form (`fields.js`), so "12 Elm St"
  matches "12 Elm Street". Holds are listed by field, reason and state;
  `holds: []` means none open for this person. `records` counts the
  `record` decisions the same way (one per field compared, including a field
  empty on both sides). `passFails: true`, allowed only in a `runAlone`
  scenario, says the phase's pass is expected to exit non-zero (the breaker
  and drop-check scenarios); a zero exit is then the failure. An expected
  date (a last gift date, a deceased date) may be an offset, resolved against
  the day of the run. `writes` counts this
  person's writes in the pass's decisions file, whose rows already carry
  `personId`, `constituentId`, `field` and `outcome` (`write-vg`,
  `deferred`, `hold`, `record`); `deferred` counts the same way.
- **Dates are relative.** A gift or deceased date is written as an offset
  from the day of the run (`'-30d'`, `'-2y'`) and resolved at seeding, so a
  scenario does not age into a different result. A fixed date is allowed
  where the date itself is the point.
- **`since`** keeps scenarios for later steps in the tree while they cannot
  pass yet. The runner skips a scenario whose step is later than the current
  one, and says so.

### Passes are global

A full pass covers everyone, so scenarios cannot each have a pass of their
own. The runner plays all selected scenarios in lockstep: every scenario's
phase 1 edits, then one pass, then every scenario's phase 1 checks; then
phase 2, and so on. A scenario with fewer phases simply has nothing to do in
the later ones, but is still checked to be undisturbed. **(call)** This is
also a test: a scenario that only passes when run alone has found a bug.

The circuit breaker is set high in `.env.harness` (`CIRCUIT_BREAKER_PEOPLE`)
so a full scenario set does not trip it. The breaker and the drop check get
scenarios of their own, which run alone with the limit set low.

### The first set: step 3

The scenarios for what step 3 already does, written first, so the harness is
proven against working code:

- Everything agrees: memory recorded, nothing written, no hold.
- A number only LGL has fills an empty VG slot; with no empty slot, a
  `phones-no-slot` hold.
- A newer gift date in LGL reaches VG; a dues gift does not count; a
  constituent with no countable gift gives `no-longer-donor` and no date
  write.
- Names that differ at the first pass are held, never changed (first name,
  last name, nickname, suffix).
- After agreement, LGL changes an address, a phone or a name: VG follows.
- After agreement, VG changes a value: the LGL write is reported as
  deferred, and nothing is written in step 3. These become LGL-write
  scenarios in step 7 by changing `since`, not by being rewritten.
- LGL clears a value after agreement: `lgl-cleared` hold.
- Deceased in LGL only: VG marked deceased with the date. A deceased mark
  removed in LGL after agreement: `deceased-removed` hold, VG unchanged.
- An unclean LGL value: `unclean` hold.
- A couple: a change to the shared LGL address reaches both people; each
  partner's first name is held.
- A value VG refuses: `vg-refused` hold, not retried on the next pass;
  dismissed, it stays quiet; changed, it reopens. The refusal is produced by
  an LGL value longer than VG's limit for that field (`PersonPatch` caps
  each string, most at 100 or 200 characters), changed in LGL after
  agreement. If LGL cleaning or the `unclean` guard stops it first, the
  scenario says so and expects `unclean` instead, and `vg-refused` stays
  covered by unit tests.
- A held field fixed by hand on one side: the hold closes and the field
  syncs from then on.
- The constituent deleted in LGL: `lgl-missing`, and the Donor mark comes
  off once step 4's `unlink` exists (`since: 4` for that half).
- Every set ends with a pass that writes nothing and opens no hold.

Later steps add theirs: matching and creating donors (4), the checks and
their cursors (6), LGL writes and everything the trial account taught about
them (7: duplicates reused, emails stored not current, addresses rewritten
by verification).

### LGL's own jobs

Two LGL jobs act on their own schedule (sync design, "On the trial
account"): address verification, about every eleven minutes, and
deduplication, once a day. A phase can `wait: 'verification'`, which polls
until the scenario's addresses carry `verified_on`, up to 15 minutes. A
scenario that needs deduplication is marked `overnight: true`; the runner
skips those unless asked. A phase marked `wait: 'overnight'` saves the state
after the phases before it and stops the run with exit 0; `--resume` picks it
up the next day, continues without reseeding, and ignores `--only` and
`--step`. **(call)** Overnight scenarios are
few and are run by hand, not as part of every run.

Scenario addresses are invented unless the scenario is about verification,
because verification rewrites a real address. LGL's own sweep tries an
invented address within about eleven minutes of seeding, stamps
`verified_on`, leaves `verified` false and rewrites nothing (trial account,
2026-11-12). The harness sets nothing itself. So an invented address never
changes value, and no wait follows seeding. "Invented" has to mean a street
that does not exist. The smoke scenario's first address, a plausible real
one, was rewritten by the sweep about eleven minutes into the final run
(street abbreviated, city and ZIP changed) and failed an undisturbed check.
Scenario streets are made-up names. In the step 4 runs (2026-11-14) even
that was not enough: two made-up streets in a real town were matched to real
streets nearby ("Larkspur Hollow" to "Larkspur Rd"; "Hartwold Lane" to "Lane
E", with a new ZIP) and rewritten. The step 4 scenarios therefore use a town
and ZIP that do not exist (`Zzyzxford`, `00901`). The stamp may move `updated_at`, which
matters only to step 6's LGL check, where a record read again compares
`same`.

Deduplication works within one constituent's entries (an address or phone
repeated on the same record), not across records. Scenarios may share names
and addresses between people. A scenario whose setup gives one constituent
two equal entries is `overnight`, whether it is about deduplication or not.
Saved state is used by `--resume` only; every other run reseeds, so a day's
deduplication never meets an ordinary run.

## The runner

```
npm run harness -- [--only <name or area>] [--step N] [--overnight] [--resume] [--guards-only]
```

1. **Guards.**
2. **Reseed** (every run, unless `--resume`):
   - VG: run the generator with donors off against the dev database. It
     empties every base table except the catalogs first.
   - LGL: delete every constituent carrying the harness marker.
   - Create each scenario's LGL constituent with its entries and gifts, then
     its VG person and donor row. Save the pairing (scenario name to person
     id and constituent id) in `out/harness-state.json`.
   - Restore the two accounts' access. The generator empties `user_data`
     and `role_grant`, so the reseed writes, by SQL, the `user_data` rows for
     `service-account-vg-sync` and `service-account-vg-sync-harness`, a
     role 8 grant for the first, Admin and role 8 grants for the second (role
     8 so it can dismiss holds as staff would, whether or not Admin carries
     the new `sync:*` permissions), and both
     privacy acknowledgements. SQL because no account can grant anything
     through the API until one has a grant. This happens before any person
     is created.
3. **Phases**, in lockstep as above. Each pass is the real service run as a
   child process with `--env .env.harness`, always with `--write-vg` and
   with `--out` set to the run's own directory, so each pass's decisions
   file is the harness's to read. (A scenario about dry runs leaves out
   `--write-vg` for its pass.) Its output is streamed to the
   screen and to `out/harness-<time>/pass-<n>.log`, never piped through
   `tail`.
4. **Checks**, after each phase, reading both systems through their APIs and
   the sync tables through `/sync/*`.
5. **Report:** one line per scenario, `PASS`, `FAIL` or `KNOWN`, and for each
   failure the phase, the field, what was expected and what was found. A pass
   that exited non-zero without `passFails` is listed as `pass N exited C`.
   The run exits non-zero if anything failed or any pass exited unexpectedly;
   `KNOWN` does not fail it. A copy goes to `out/harness-<time>/report.txt`.

A reseed costs LGL requests: about one per constituent, entry and gift, so a
few hundred for the full set, and the rate limit is 300 in five minutes.
**(call)** The service's `lgl.js` is read-only and stays so until step 7.
The harness has its own small LGL write client in `harness/`, using the
same retry policy (it may import the request helper from `lgl.js` if that
is exported, or copy it). A reseed is expected to take several minutes.
Every run reseeds unless `--resume` is given, because the previous run has
changed the scenarios' starting records. The step 3 set of 21 scenarios takes
about 25 minutes, most of it waiting out the LGL rate limit during checks.

**`--only`.** The VG side is always reseeded whole: the generator cannot
reseed part of the database, and it is quick. On the LGL side, every
harness constituent is deleted and only the selected scenarios' are
created, so no stale record from an earlier run is pulled by the pass. The
saving is in the creates, which are most of the requests.

## Where the code goes

| Path | Job |
|---|---|
| `harness/run.js` | The runner |
| `harness/guards.js` | The checks that both targets are the test ones |
| `harness/seed.js` | Reseeding both systems from the scenarios |
| `harness/expect.js` | Comparing what was found with `expect`, in comparable form |
| `harness/vg-staff.js` | VG edits as staff, with the `vg-sync-harness` client |
| `harness/scenarios/*.js` | The scenarios |

The harness may import from `src/lgl-vg/` (the LGL client, `fields.js` for
comparable forms, the VG client). Nothing in `src/` imports from
`harness/`. `npm test` does not run the harness, since it needs both live
systems. The harness's own pure parts (`expect.js`, the lockstep ordering,
the guards' decisions) get unit tests in `npm test`.

## How it is used through the build

- **Each step's work starts by adding or switching on its scenarios**
  (`since`), which fail; the step is done when they pass, the full set still
  passes, and the closing dry run against the production snapshot looks
  right.
- **Agents run it** without asking, per the run rule. A run touches only the
  dev database and the trial account.
- **The step 3 write run** that was paused is replaced by the first
  scenario set. Step 3 is done when its scenarios pass.

## Rulings made during the build

Decisions the agent made while building the harness (2026-11-13), with what
each costs if it proves wrong. The engineer has seen the list; none is
reversed.

| # | Ruling | Where | Cost if wrong |
|---|---|---|---|
| R1 | Each pass runs with every variable named in `.env.harness.example` removed from its inherited environment, so a production key exported in the shell cannot reach it. | `serviceEnv` in `harness/vg-db.js`; "Guards" | None; a margin of safety. |
| R2 | The exact LGL field names found by discovery are written into this design. | "Left to the builder" | Later code guesses at them. |
| R3 | A fixed list of scenario and phase keys; any other key is refused at load. | `SCENARIO_KEYS`, `PHASE_KEYS` in `harness/scenario.js` | A new key has to be added there. |
| R4 | A hold whose `firstSeenAt` is at or after the pass's start counts as opened by that pass. | `passStartedAt` in `harness/expect.js` | A reopened hold keeps its old `firstSeenAt`, so the "undisturbed" check misses it. |
| R5 | On the trial account, Credit Card stands in for PayPal; ordinary gifts use Check or Cash. | "Left to the builder" | An ordinary card gift into the stand-in fund would count as dues. |
| R6 | `passFails` (a pass expected to exit non-zero) only in a `runAlone` scenario. | "Scenarios" | A failing pass can't share a run with others. |
| R7 | `wait: 'overnight'` saves state and stops; `--resume` continues. | "Scenarios", "The runner" | Rework when the first overnight scenario is written. |
| R8 | A scenario failing only in `known` phases reports `KNOWN` and does not fail the run. | "Scenarios" | A one-line change makes them fail. |
| R9 | The unclean guard holding a to-LGL case was a sync bug, fixed to match the sync design's text. | `COPIES_TO_VG` in `src/lgl-vg/plan.js` | The design text changes instead and the fix is reverted. |
| R10 | The dismissed-hold scenario asserts reopen-on-change; the app's "permanent" text was a finding. | `harness/scenarios/holds.js` | Settled 2026-11-14: the design was right; the app's text is noted on the board item. |
| R11 | Git history with real street addresses was left for the engineer. | — | Settled 2026-11-14: the branch was squash-merged, so `main` holds none. |

## Left to the builder

- The harness marker on LGL records (see "Guards").
  **Settled 2026-11-13** (`harness/discover.js` on the trial account): the
  constituent field `external_constituent_id`, set to `vg-sync-harness`
  (`HARNESS_MARKER` in `harness/lgl-write.js`) on every create. Any number of
  constituents may share it. The search finds them with
  `GET /constituents/search?q[]=external_id=vg-sync-harness`: an exact match
  (a prefix finds nothing). The key `external_constituent_id` is refused by
  the search with a 400.
- Whether LGL's API can create funds, payment types and gifts, and with which
  fields. Gifts are needed.
  **Settled 2026-11-13:**
  - Funds: `GET /funds`, `POST /funds {name}`. The trial account had none;
    discovery created **"Harness Membership"**, which stays as the stand-in
    for the membership fund, and a second fund, **"Harness General"**, for
    ordinary gifts (discovery reuses any active fund not named like
    "membership", else creates it). Its id is `LGL_MEMBERSHIP_FUND_ID` in
    `.env.harness`. Discovery reuses a fund whose name contains
    "membership" before creating one.
  - Payment types: `GET /payment_types` only; the API cannot create
    payment types. The trial account has Cash, Check, Credit Card and Stock,
    no PayPal. **On the trial account the existing Credit Card type stands
    in for PayPal**: its id is `LGL_PAYPAL_PAYMENT_TYPE_ID` in
    `.env.harness` (`discover.js` prints it). Ordinary scenario gifts use
    Check or Cash, so they are never mistaken for dues.
  - Gifts: `POST /constituents/{id}/gifts` with `gift_type_id`, `fund_id`,
    `payment_type_id`, `received_amount`, `received_date` (`YYYY-MM-DD`).
    Only `gift_type_id` is needed in practice; the docs also mark
    `gift_type_name` required, but the create succeeds without it. Gift types
    come from `GET /gift_types`; use the one named "Gift". A gift reads back
    with `fund_id` and `payment_type_id` as sent, and `DELETE /gifts/{id}`
    removes it.
- Deceased (**settled 2026-11-13**): `PATCH /constituents/{id}` with
  `is_deceased` (boolean) and `deceased_date` (`YYYY-MM-DD`). The names need
  not be sent and are kept. A deceased constituent still appears in
  `/constituents/search`.
- Phone type (**settled 2026-11-13**): `phone_type_name` on
  `POST /constituents/{id}/phone_numbers` ("Home", "Work", "Mobile", "Other",
  ...; the list is `GET /types/phone_number_types`). The answer carries
  `phone_number_type_id` for it. An unknown name is not refused: the entry is
  stored as Home.
- Reading one constituent: `GET /constituents/{id}` refuses `expand`, so
  the three entry lists are read with `GET /constituents/{id}/<kind>`. A
  deleted constituent reads as 404.
- How an LGL merge can be produced on the trial account. If only the LGL
  screen can merge, merge scenarios get a hand step, or wait until step 4
  shows whether a merge can be detected at all.
  **Settled 2026-11-13:** the API has no merge call (none in the published
  api-docs). Merges are made only in the LGL screen; merge scenarios wait
  for step 4.
- The exact shape of `expect` beyond the fields above, as scenarios need it.
  **Settled:** `vg` and `lgl` values, `lastGiftDate`, deceased, `holds`,
  `writes`, `deferred`, `records` and `passFails`, all as described under
  "Scenarios". Expected records in a hold list carry `field: null` for
  record-level holds, as the API returns them.
- Whether the VG person and donor rows are created through the API (as the
  harness client) or by SQL. **(call)** Through the API, so the records are
  shaped as the app makes them; SQL only where the API cannot do it.
