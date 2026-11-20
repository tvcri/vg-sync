# Handoff: go-live

2026-11-16. For the next session in this repo. Board item VG-202611-521
(#153 in `tvcri/village-green`); commits end with `Refs #153`.

## Where things stand

- **Step 7 is on branch `lgl-vg-step7`, not merged and not pushed.** It sits
  on `lgl-vg-step6`, which is also unmerged. The engineer decides the merge
  style. A push to `main` that changes more than `README.md` and `docs/**`
  builds an image.
- Design: `docs/superpowers/specs/2026-11-16-lgl-vg-step7-lgl-writes-design.md`.
  Its "What the rehearsal showed" has every result and "Rulings during the
  build" the calls made on the way. Plan:
  `docs/superpowers/plans/2026-11-16-lgl-vg-step7-lgl-writes.md`.
- `npm test` passes (717). The harness's full set passes: 59 passed, 0
  failed, 1 known, in about 25 minutes (`out/harness-step7-full.log`).
- **The production service is not started,** and nothing on the VM has
  changed. Nothing has been written to production LGL or production VG.
- **The dev VG database holds the harness's invented data.** Snapshots:
  `out/dev-vg-before-step7.sql` (harness data) and the older
  `out/dev-vg-before-step6.sql`. A production snapshot restored into the dev
  database is at an older migration than the harness generator refuses;
  restore `out/dev-vg-before-step7.sql` before the next harness run. After a
  production snapshot is restored, the service account needs its user row and
  grant again (`harness/vg-db.js`, role 8 at federation level, then `npm run
  setup -- --acknowledge-privacy`).

## What step 7 added

- `src/lgl-vg/lgl-calls.js` (pure): `buildLglCalls` and `formatCall`. Find by
  value, reuse a current entry, revive a not-current one, add, retire the entry
  the sync read (`PATCH {not_current: true}`, never a delete); the addressee
  and salutation rule.
- `src/lgl-vg/apply-lgl.js`: the stale check against a fresh read, the sends,
  the read-back check, `sync_log` rows for every call sent, refusals
  (`lgl-refused`).
- `src/lgl-vg/lgl.js`: `getConstituentFull`, `listEntries` (refuses a
  truncated list), `addEntry`, `patchEntry`, `patchConstituent`; a POST is
  retried on 429 only.
- `src/lgl-vg/plan.js`, `fields.js`, `holds.js`, `policy.js`: `lglWrites` in
  the plan, `entryIds` for every picked entry, `comparable` through
  `stateCode`, and the holds `po-box`, `flapping`, `lgl-refused`, `addressee`
  and `vg-cleared` in the plan.
- `src/lgl-vg/config.js`, `main.js`, `service.js`, `pass.js`, `check.js`,
  `check-plan.js`, `apply.js`, `vg.js`: `--write-lgl` / `WRITE_LGL` (needs
  `--write-vg`), `LGL_WRITE_ALLOW` (ids or `all`; empty means none), the
  flapping count (more than 3 runs in 30 days), the 5000-row failure,
  `getSyncLog` taking `outcome` as a string or an array.
- Harness: `harness/scenarios/to-lgl.js` (16 scenarios), `expect.lglWrites`,
  `expect.lgl` addressee and salutation, `expect.lglEntries`, runs with
  `--write-lgl`. `.env.harness` (gitignored) needs `LGL_WRITE_ALLOW=all`.
- `seed-import` now runs without `--write-lgl`.

## Fixed after the final review

1. A call that fails without a refusal (timeout, 5xx, 429 out of attempts) is
   logged in `sync_log` with outcome `failed` before the run fails.
2. A failed run saves what it gathered: memory upserted and the new holds
   opened (an `addressee` hold included), nothing closed or reopened.
3. A field left with an old entry current beside the new one (an add or
   revive answered, its retire not) opens an `lgl-incomplete` hold (not
   owned) naming the calls answered, the old entry (`oldEntryId`) and the new
   one (`newEntryId`). Narrowed 2026-11-17; see below.
4. The stale check compares an unclean LGL value as stored (`lglExpect`, shared
   by plan and apply), so an unclean-to-unclean edit, or an edit of the clean
   phone slot beside an unclean one, is stale.
5. A log append that also fails on the failure path is named in the error,
   so the PASS FAILED / CHECK FAILED line carries it.
6. Two writes to the same constituent and field in one run are refused before
   anything is sent.

## Go-live tasks for the engineer

**Simplified 2026-11-19 by the engineer, after several rehearsals** (the
last with the mock LGL): the service comes up with writes on in both
systems at once. The staged rollout planned on 2026-11-16 (LGL writes printed only, a
handful of donors, the backlog by hand) is dropped. The README's "Go-live
order" has the steps:

1. The step 5 VM tasks, unchanged:
   1. On the VM, install the new `sidecar-deploy.py` and
      `ship-container-logs.py` (to `~/tvcri/sidecar-deploy/` and
      `~/tvcri/logship/`). Right after installing the deployer, run
      `python3 sidecar-deploy.py --service email --dry-run`.
   2. On the VM, create `vg-sync/out` owned by uid 1000 and `vg-sync/.env`,
      readable by uid 1000.
   3. Add `sync` to the VM's compose file, pinned by digest, as in
      `deploy/docker-compose.example.yml`.
   4. `alerts-sync.sh enable` (never `create` again: it disables them).
2. `seed-import --write-vg` into production VG, loading the import review's
   decisions (the README's "Loading the import's decisions").
3. Optional, read-only: `report --save-snapshot` before the first write.
4. Start the service with `WRITE_VG=true`, `WRITE_LGL=true`,
   `LGL_WRITE_ALLOW=all`, `POLICY_FILE=policy-reconcile.json` and
   `CIRCUIT_BREAKER_PEOPLE=500`. The service runs a full pass at start; that
   pass is the backlog and the reconciliation below. At the default breaker
   of 50 it would fail without writing, and fail again every night.
   (`--max-people` exists only on the one-off command.)
5. After the first `PASS OK full`, remove `POLICY_FILE` and
   `CIRCUIT_BREAKER_PEOPLE` from `.env` and restart. Until then the checks
   between passes run with the same settings.
6. Point staff at VG's LGL sync screen only after that pass.

Counts from the 2026-11-16 rehearsal, as a guide: about 232 LGL field
writes on about 194 people in 322 calls, plus about 56 name writes from the
reconcile policy and 31 people for VG.

## Reconcile blanks before staff see holds

Decided 2026-11-19 by @csmig (an engineering decision, not a customer one).

**A blank is never an authoritative value.** Where one system has a value
and the other has none, and the pair has never agreed, the blank side takes
the other side's value. This is a one-off reconciliation at go-live, not a
standing rule: `never-agreed` is a go-live state, and the ongoing policy is
about edits after agreement.

Why: the 2026-11-19 rehearsal (production snapshot of 11:00, seed-import,
then a VG-only full pass) opened 152 holds. 63 are nickname holds, and 62
of those are one side blank, not a disagreement. Putting non-decisions in
front of staff on day 1 is the failure to avoid.

What to build:

- A policy action that fills only a blank side, in either direction, and
  holds a real difference exactly as today (`fill-blank`, or another name).
  No existing action does this: `to-lgl` on `never-agreed` also overwrites a
  different LGL value, and `to-vg` empties VG wherever LGL is blank
  (`docs/policy.json.5.md`).
- `policy-reconcile.json`: `policy.json` with `fill-blank` on `never-agreed`
  for the four name fields. Address and phones already fill a blank side
  from the other on `never-agreed`; check that, don't assume it. **Email
  stays as it is** (held when only LGL has one): a new VG email can put a
  person on VG's mailings, so copying them waits for staff to agree to that.
- After the run, the filled pairs are agreed in the sync memory, and the
  open holds the pass no longer wants close as usual.

Unchanged:

- `policy.json` keeps `hold` on `never-agreed` for names. After
  reconciliation, a blank that appears is someone clearing a value, and
  clearing stays held in both directions.
- Real differences (first names, phone slots, couples, PO boxes) still go to
  staff as holds.

Check before go-live: rerun the rehearsal with the reconcile policy and
compare the open-hold count with 152. Expect about 90; most of the 30 first
name holds look like real differences.

**Built 2026-11-19** (branch `fill-blank`): the `fill-blank` action (allowed
on `never-agreed` only; an unclean LGL value is held `unclean`, not filled),
`policy-reconcile.json`, which the image now carries, and
`docs/policy.json.5.md`. Checked:

- Address does **not** fill a blank side: `to-lgl` holds a VG blank as
  `never-agreed`. The rehearsal has no such pair, so it is left as it is.
  Phones' `merge` fills both ways, as assumed.
- Dry full passes on the rehearsal's database (2026-11-19, production LGL;
  `out/dry-2026-11-19-reconcile/`): with `policy.json` 152 open; with
  `policy-reconcile.json` **88**. Nicknames 63 → 1 held (8 filled in VG, 54
  in LGL), first names 30 → 29 (1 filled in LGL), suffix 1 → 0; the 3 last
  names stay. The backlog pass therefore sends about 56 more LGL name
  writes than the step 7 counts above.
- The customer's answer to question 3 (2026-11-12) was "names listed, not
  changed". Filling a blank name goes past it, so the engineer asked; the
  customer agreed on 2026-11-19 (the design's policy section).

Also: the README's "Setting up the service account" says to grant the Staff
role. Since VG's #155 the account's role is Sync Service (role 8, federation
level), as "Where things stand" above already says. Fixed 2026-11-19.

## Still open

Carried from the 2026-11-15 handoff:

- A street name LGL's verification changes is copied to VG (for the
  customer's list); "telling staff" how held records reach them; the stale
  Claude Doc copy of the sync design; a stalled read after the response
  headers gives a raw error message; tracked `.pyc` files in `vg-utils`.
- Trial experiments still unmapped: units and directionals under
  verification, and not-current phones. Addressee and salutation, and
  not-current emails, were settled in step 7.
- Small items from the step 6 reviews: two LGL edits in the same second
  around a check's read wait for the nightly pass; the decisions file is
  written after the cursor moves; by hand, a gift with no `updated_at` is left
  out; an open `unlinked` notice can close a little before its link is made; a
  token request that fails on the network gets an `/op/state` lookup; a throw
  while arming a tick would stop ticks until the next good full pass.
- A write to LGL comes back through the LGL check; the harness scenario
  `own-write-comes-back-through-lgl-check-as-same` shows it comes back once,
  as `same`. Watch the first production ticks after a write for a repeat.

Deferred minors from the step 7 reviews:

- No test that a PATCH timeout is retried (the network-throw path is covered).
- `listEntries` accepts a response without `total_items`; more than 100
  entries of one kind is a permanent read failure (could page).
- A "(Jay)"-only first name sends an empty first name; find-by-value hitting a
  current entry that was not read is untested.
- A couple's `lgl-refused` is re-desired for every partner; `deferred=` counts
  decisions, so a couple counts 2.
- Fingerprints for full-name VG states changed when `comparable` reduced state
  to its code; the dry run did not show a problem.
- An add response with `not_current` false but no id gives `lglEntryId` null.
  A retire 404 could also be a wrong path (indistinguishable). An add whose
  check read failed is logged `written` with the note `not checked`.
- The check's 5000-row test has no `final: true` assertion; `countLglWrites`
  merges missing run ids; the service's log-read assertion is weak.
- `harness/expect.js` lines 11 and 12: a comment still groups addressee and
  salutation with the gift-derived clause. The allow-list scenario hard-codes
  an id; the harness's lglLog sorts by `Number(logId)`; one known stale
  scenario's noise remains.

Fixed after a code review of the branch (2026-11-17):

- A revive answered 404 (the entry deduped away) no longer opens an
  `lgl-refused` hold that blocks the write for good: the field is stale and
  the next run adds it.
- A refusal after the field's add went through (a retire refused) opens
  `lgl-incomplete`, so the old entry left current reaches staff.
- An add answered without an entry id fails the run instead of logging a sent
  add as refused. A failed check read names the read in the hold, not the add.
- The `lgl-incomplete` hold opens only when an add or revive was answered
  and its retire was not, and names the old and the new entry. Before, a
  phone write that stopped at the cell's add (after the home number was done)
  named the old cell as "left current beside the new one" when no new cell
  existed, so staff following it could retire the donor's only cell. Such a
  stop now opens no hold; the next run sends the cell. Found in the step 7
  build's last re-review.
- The flapping log is read per person the guard looks up, in every mode: a
  run with LGL writes off no longer closes flapping holds, a check with
  nothing for LGL reads no log, and the 5000-row limit is per person.
- The dry run's `lgl-writes=` is the count a run with LGL writes on would send.
- Shared helpers (`squash`, `phoneKey`, `ENTRY_FIELDS`, `isRefusal`,
  `aborted`) are defined once.

Parked from that review: `getConstituentFull` reads all three entry lists
for every constituent written, even a name-only write (four GETs; LGL's
~300-request budget is reached sooner on a big backlog; the 429 pause still
applies, so it is slower, not wrong).

Parked minors from the final review:

- The log is appended once per constituent, not per call: a SIGKILL during a
  429 wait can lose that constituent's log rows for calls already sent.
- VG is not re-read before an LGL write; a VG edit in between settles on the
  next run.
- A note for staff: an `lgl-incomplete` hold needs a person to retire the old
  entry (its `oldEntryId`) in LGL by hand; the sync never closes it.

## Lessons from the step 7 build

Built task by task (a fresh implementer and a review per task), eleven tasks.

1. **Reviewers kept finding cross-task invariants.** Each task passed on its
   own; the faults sat between tasks: an unclean value's repair had to retire
   the entry the sync read (so `entryIds` had to be recorded upstream);
   VG's state had to compare as the code LGL stores, or a never-agreed address
   read as changed forever and looped to flapping; `seed-import`'s argv had to
   work without `--write-lgl`. Write the invariant down in the ledger when
   the earlier task is accepted, not when the later one breaks it.
2. **Trial account experiments before design paid off.** Addressee rebuild,
   one preferred phone per constituent and verification rewrites were settled
   on the trial account first, and the design held through the build.
3. **A write must not go unrecorded.** The rulings that mattered most were
   about the log: a sent add is logged before its check, a retire 404 is done,
   flapping counts distinct runs.
4. **The full harness takes about 25 minutes.** The driving session runs it;
   implementers run focused groups.
5. **A dry run that fails on data it will not send is wrong.** Steps 1 to 6
   never failed that way; the state conversion now throws only for a write
   that will be sent.
6. Lessons 3 to 6 of the step 6 handoff still hold (restore the harness
   snapshot first, trial account reads can move under you, wide by-hand checks
   are slow, pushes build images).
