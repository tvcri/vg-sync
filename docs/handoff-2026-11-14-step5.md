# Handoff: step 5, scheduler and deploy tooling

2026-11-14. For the next session in this repo. Board item VG-202611-521
(#153 in `tvcri/village-green`); commits end with `Refs #153`.

## Where things stand

- **Step 4 is built on branch `lgl-vg-step4`**, not yet merged to `main`
  (the engineer's call, as with step 3's squash-merge). Plan:
  `docs/superpowers/plans/2026-11-14-lgl-vg-step4-unlinked-donors.md`. Its
  rulings are in the sync design, "Unlinked donors" and "Gone from LGL".
- `npm test` passes (391). The harness's full set passes: 38 scenarios,
  19 of them step 4's (`harness/scenarios/unlinked.js`, plus the unlink
  scenario in `records.js`). `--step` now defaults to 4.
- **The dev VG database holds a restored production snapshot** (2026-11-14
  15:15) with the import's decisions loaded by `seed-import`. It is real
  data. The next harness run reseeds it.
- The production dry run's numbers are in the design's "Build order",
  step 4.

## What step 4 added

- `src/lgl-vg/unlinked.js`: link, create, follow, finish or hold each LGL
  donor with no link; unlink a person whose record is gone, or follow it to
  the record that replaced it.
- `src/lgl-vg/apply.js`: unlinks and follows, then one fresh read of every
  person and a fresh plan before links, finishes and creates. A create opens
  a `create-unfinished` hold before its donor row.
- `src/lgl-vg/seed.js` and `main.js seed-import`: the one-time load of the
  import review's decisions.
- Hold ownership in `holds.js`: step 3 and step 4 each close only their own.

## Still open

- ~~An LGL merge on the trial account.~~ Done 2026-11-14: the merged-away
  id answers 404 and leaves no trace on the kept record, so a merge is a
  deletion to the sync, as step 4 assumed (design, "Gone from LGL").
- LGL's address verification rewrites even made-up streets in a real town
  (harness design, "LGL's own jobs"). New scenarios use the town
  `Zzyzxford`, ZIP `00901`.
- **A street name LGL's verification changes is copied to VG today.** The
  engineer's ruling (finding (d)) covers a rewrite of the town and ZIP; a
  changed street name or house number goes further (a typo or a new street
  can be "corrected" to a different real one). Proposed, not built or
  agreed: hold such a rewrite for staff instead of copying it. Whether VG
  should take it is the customer's call, for their question list. The
  engineer confirms the trial and production settings match for address
  verification and address and phone deduplication.
- From the step 4 handoff, unchanged: "Telling staff"; read the Azure
  "email sidecar silent" alert before step 5; the stale Claude Doc copy of
  the design; trial experiments due before step 7.

## Step 5

The sync design's build step 5: the long-lived service running a nightly
full pass, writing to VG only; the CI image build, the generalized deployer
(`vg-utils/vm-sidecar-deploy`), log shipping and the two alerts, rehearsed
outside production. The production service is not started.
