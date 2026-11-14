# Handoff: step 4, unlinked donors

2026-11-14. For the next session in this repo. Board item VG-202611-521
(#153 in `tvcri/village-green`); commits end with `Refs #153`.

## Where things stand

- **Steps 1 to 3 are built and on local `main`**, squash-merged. `main` is
  ahead of `origin/main` and not pushed; pushing is the engineer's call.
  `npm test` passes. The harness's 21 step 3 scenarios pass live.
- **The four engineer findings from the harness build are settled**
  ("Findings for the engineer" in the sync design). Nothing waits on the
  engineer.
- **Old local branches** `lgl-trial-findings` (worktree `../vg-sync-trial`),
  `lgl-vg-step1` and `lgl-vg-design` are fully contained in `main`, but their
  history holds real street addresses. Never push them. They can be deleted,
  with the worktree, once the engineer agrees.

## Step 4

The sync design's build step 4: "Linking and creating, and the one-time load
of the import's decisions." Read, in the sync design:

- "Unlinked donors": the Link, Create and Hold table, the three rules against
  duplicates, create as two calls.
- "Staff decisions are not undone": the import's skip and hold decisions are
  loaded once as dismissed holds. **That seed holds real ids and goes into
  the VG database, never this repo.** Its source is
  `~/dev/tvcri/vg-utils/lgl-import` (see `CLAUDE.md`'s table).
- The record action `unlink`, which waits for step 4 ("where merges are
  looked at"), customer question 5 (follow a merge; a deleted donor loses
  the Donor mark), and "Left to the builder": whether an LGL merge can be
  detected at all. The API has no merge call, so a merge scenario on the
  trial account needs the engineer to merge two records in the LGL screen.
- The anti-goals: a duplicate person in VG, and linking two different
  people, are the failures this step can cause.

Expected order, as in step 3: design questions answered from the docs first,
then a plan (`docs/superpowers/plans/`), then step 4 harness scenarios that
fail (`since: 4`), then the code until they pass and the step 3 set still
passes, then a dry run against a restored production snapshot.

## Running things

- `npm test`: unit tests.
- `npm run harness -- [--only <name or area>] [--step N]`: reseeds the dev VG
  database and the LGL trial account, then runs real passes. It runs about
  25 minutes for the full set, mostly the LGL rate limit. Agents run it
  without asking. `.env.harness` is gitignored; `.env.harness.example` names
  its variables.
- The trial account holds the sentinel "Zztrial Sentinel" and harness
  records only. The harness guards refuse to run otherwise.
- The harness design's "Rulings made during the build" lists the choices
  made while building it.

## Still open, not for step 4

- "Telling staff" in the sync design: how held records reach staff.
- Before step 5: read the Azure "email sidecar silent" alert's definition.
- The Claude Doc copy of the sync design is stale; the repo copy is current.
- Trial experiments not yet run: addressee and salutation for other name
  shapes, verification of units and directionals, not-current emails and
  phones. Due before step 7.
