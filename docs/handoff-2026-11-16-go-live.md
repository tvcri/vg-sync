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
3. A field whose calls stop part way opens an `lgl-incomplete` hold (not
   owned) naming the calls sent and the entry left current (`oldEntryId`).
4. The stale check compares an unclean LGL value as stored (`lglExpect`, shared
   by plan and apply), so an unclean-to-unclean edit, or an edit of the clean
   phone slot beside an unclean one, is stale.
5. A log append that also fails on the failure path is named in the error,
   so the PASS FAILED / CHECK FAILED line carries it.
6. Two writes to the same constituent and field in one run are refused before
   anything is sent.

## Go-live tasks for the engineer

The design's "Go-live" has the order; each stage that writes to production LGL
needs the engineer's go-ahead.

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
   decisions (the README's "Loading the import's decisions"). Needs the
   engineer's go-ahead.
3. Start the service with `WRITE_LGL=true` and an empty `LGL_WRITE_ALLOW`: VG
   writes on, LGL writes printed and counted. Save a full LGL snapshot. Review
   the first passes' printed calls.
4. A handful of real donors on the allow-list: a never-agreed address, a PO
   box, a hand-written addressee, a name change, a couple, a phone and a cell.
   Check each by hand in LGL, including the address verification rewrite
   (5 to 11 minutes later).
5. The backlog, by hand. The 2026-11-16 rehearsal planned about 232 LGL field
   writes on about 194 people, 322 calls (phones 136 fields, email 52, address
   43, deceased 1), plus 31 people for VG. That is far over the 50-person
   breaker, so run `--once full --write-vg --write-lgl` with
   `LGL_WRITE_ALLOW=all` once to get the breaker's message (it writes nothing
   and reports the true count), then rerun with `--max-people <n>` from it.
   Then `LGL_WRITE_ALLOW=all` in the service's `.env`. The production backup
   will have moved by then; the counts are a guide, not a promise.

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
