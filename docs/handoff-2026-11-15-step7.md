# Handoff: step 7, VG to LGL, then go-live

2026-11-15. For the next session in this repo. Board item VG-202611-521
(#153 in `tvcri/village-green`); commits end with `Refs #153`.

## Where things stand

- **Step 6 is on branch `lgl-vg-step6`, not merged and not pushed.** The
  engineer decides the merge style. A push to `main` that changes more than
  `README.md` and `docs/**` builds an image.
- Design: `docs/superpowers/specs/2026-11-15-lgl-vg-step6-change-checks-design.md`
  (the step 6 design). Its "What the rehearsal showed" has every result.
  Plan: `docs/superpowers/plans/2026-11-15-lgl-vg-step6-change-checks.md`.
- `npm test` passes (581). The harness's full set passes: 44 scenarios, six
  of them step 6 scenarios (`harness/scenarios/checks.js`).
- **The production service is not started,** and nothing on the VM has
  changed. The step 5 go-live tasks are unchanged (below).
- **The dev VG database holds the harness's invented data.** Snapshots:
  `out/dev-vg-before-step6.sql` (harness data, at migration 0034) and
  `out/dev-vg-before-step5.sql` (a restored production snapshot, real data).
  Production backups restore at migration 0033, which the harness's
  generator (0034) refuses; restore `out/dev-vg-before-step6.sql` before
  the next harness run if a production snapshot is in the dev database.
- After a production snapshot is restored, the service account needs its
  user row and grant again. `npm run setup` says what a person must do; the
  grant can also be written by SQL as the harness reseed does
  (`harness/vg-db.js`, role 8 at federation level), then `npm run setup --
  --acknowledge-privacy`.

## What step 6 added

- `src/lgl-vg/check-plan.js` (pure): which constituents a check touched
  (`mergeLglChanges`, `vgTouched`), the LGL cursor (`lglCursorAfter`), the
  check's plan over touched constituents (`planCheck`), the breaker count
  (`breakerPeople`, gift-date-only people left out) and `foundChange`. A
  check never unlinks, never acts on `lgl-missing` or `no-longer-donor`, and
  passes `reconcileHolds` only the holds of the constituents it touched.
  Matching still runs over every unlinked donor; the results are cut to the
  touched ones. A constituent read again counts as touched only when its
  `updated_at` changed.
- `src/lgl-vg/check.js`: `runCheck` for both checks. The VG check reads the
  change feed from its cursor and reads up to 20 touched constituents fresh
  from LGL (more than 20: the cache). The LGL check reads constituents and
  gifts changed since its cursor (`lglCheckWindow`). Cache and cursors are
  committed only when a check succeeds. The check breaker counts `ok` check
  runs since the later of 24 hours ago and the start of the last good full
  pass, and fails safe if it cannot read them all. A failed VG request gets
  one `GET /op/state` lookup, added to the message.
- `src/lgl-vg/abort.js`: the stop and ceiling helpers, shared with the full
  pass.
- `src/lgl-vg/scheduler.js`: one tick timer, 60 seconds after the previous
  tick ended; the LGL check every fifth tick, every fifteenth once neither
  check has found a change for an hour. No tick before the first good full
  pass. `CHECK FAILED`, then `PASS FAILED … failing since` after 15 minutes
  and hourly after that, then `CHECK RECOVERED`. A refused credential or a
  breaker trip halts both checks until a full pass succeeds (which also
  resets the failure clock). An LGL 429 puts the LGL check off five
  minutes. `SYNC ALIVE` gains `last-vg-check`, `last-lgl-check`,
  `lgl-every`.
- `src/lgl-vg/service.js`: shared state (the LGL cache from the full pass,
  both cursors), one abort per check, `CHECK_TIMEOUT_MINUTES` (default 5).
- `src/lgl-vg/pass.js`: the full pass reads the change feed to its end
  before reading VG people and records `vgCursor`.
- `--once vg-check [--after <auditId>]` and `--once lgl-check [--since
  <ISO>]`, dry without `--write-vg`. A check by hand that finds nothing
  prints `CHECK OK <kind> <mode> no changes`.
- Harness: a phase may run `lgl-check` or `vg-check`; check phases need
  `runAlone`, which can now name a group of scenarios that share a reseed.

## Go-live tasks for the engineer

Unchanged from the step 6 handoff. All wait for the one go-live after
step 7.

1. On the VM, install the new `sidecar-deploy.py` and
   `ship-container-logs.py` (to `~/tvcri/sidecar-deploy/` and
   `~/tvcri/logship/`). Right after installing the deployer, run
   `python3 sidecar-deploy.py --service email --dry-run`.
2. On the VM, create `vg-sync/out` owned by uid 1000 and `vg-sync/.env`,
   readable by uid 1000.
3. Add `sync` to the VM's compose file, pinned by digest, as in
   `deploy/docker-compose.example.yml`.
4. `alerts-sync.sh enable` (never `create` again: it disables them).

## Still open

- Carried from step 6: a street name LGL's verification changes is copied
  to VG (for the customer's list); "telling staff" how held records reach
  them; the stale Claude Doc copy of the sync design; trial experiments
  (addressee and salutation, units and directionals, not-current emails
  and phones), due before step 7; a stalled read after the response
  headers gives a raw error message; tracked `.pyc` files in `vg-utils`.
- **A check's own write to VG is an audited change,** so the next VG check
  touches the same person once more. It writes nothing then and does not
  repeat, but a deferred decision on that pair is reported again. Step 7
  turns deferred decisions into LGL writes; check that a write to LGL
  likewise comes back through the LGL check only once.
- **Deferred decisions repeat whenever their pair is touched,** and each
  counts as a found change. Step 7 removes most of them.
- Left from the step 6 reviews, small: two LGL edits in the same second
  around a check's read wait for the nightly pass; the decisions file is
  written after the cursor moves; by hand, a gift with no `updated_at` is
  left out, and the gift bound assumes LGL reads a bare date as UTC; an
  open `unlinked` notice can close a little before its link is made, when
  the link is to a constituent the check did not touch; a token request
  that fails on the network gets an `/op/state` lookup; a throw while
  arming a tick would stop ticks until the next good full pass.
- The harness's LGL checks run by hand, and every pair is seeded inside
  the check's window, so the scenarios show what a touched pair's check
  decides. Narrowing, and a gift seen through the gift read alone, rest on
  unit tests.

## Lessons from the step 6 build

Built task by task (a fresh implementer and a review per task), then a
whole-branch review and one fix wave.

1. **The whole-branch review found what the task reviews could not.** The
   LGL check's two-minute overlap re-touched the newest constituent on
   every check: each task was right on its own, the loop only showed across
   `check-plan.js`, `check.js` and the scheduler. The container rehearsal
   showed it too (`deferred=1` on a quiet tick) before anyone named it. Read
   a rehearsal's quiet ticks as closely as its busy ones.
2. **Write back what the design means, not only what it says.** Three
   rulings during the build corrected the plan against the design: "found
   a change" excludes steady states; a full pass must really clear the
   breaker (count only since it); a by-hand LGL check starts from the cache
   as it stood at the cursor.
3. **A production snapshot is at an older migration than the harness
   generator.** Restore the harness snapshot before a harness run.
4. **LGL's trial account can move under a read.** `Incomplete read of
   /gifts/search: got 7 of 6` failed one full pass. Rerun the group with
   `--only <file>` before suspecting the code.
5. **A by-hand check over a wide window is slow.** A week of VG changes
   touched 366 donors and took 12 minutes on LGL's rate limit. Use
   `--once full` for anything wide.
6. Lessons 5 to 11 of the step 6 handoff still hold (generator check, work
   in place, the driving session runs the long runs, `vg-utils` branches,
   pushes build images, Azure alert windows, marker waits).

## Step 7

The sync design's build step 7: writes to LGL, using the calls verified on
2026-11-11, so deferred (`to-lgl`) decisions are carried out. Then the one
go-live. Start with the sync design's "VG to LGL" material and the trial
experiments still open above.
