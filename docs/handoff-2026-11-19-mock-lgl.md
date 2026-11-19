# Handoff: a mock LGL for full rehearsals

2026-11-19, from the Village Green session (village-green-90). Board item
VG-202611-521 (#153); commits end with `Refs #153`.

## Status (2026-11-19, built)

Built on branch `lgl-mock` in this repo; README "Rehearsing with a mock
LGL" says how to use it. `phones-list` was merged into local `main` first
(not pushed) after the full harness (61 passed, 2 phone scenarios updated
to the list read and passing, 1 known).

- **A mock `fetchImpl`, not a mock client.** The real client's request,
  paging, retry and error code runs unchanged; the mock answers each route
  the client calls (searches with `updated_from`, the constituent read, its
  gifts, the three entry lists, the probe, and the three writes). A route
  it doesn't know answers 404, and a URL outside LGL's API throws.
- `openLgl(config, deps)` (`src/lgl-vg/lgl-mock.js`) is the one factory;
  `main.js` uses it in the full pass, the checks, the service and the
  report. `LGL_MOCK` makes `LGL_API_KEY` optional.
- A mock run's first line is `LGL MOCK <file>: ...`; its PASS and CHECK
  lines end with `lgl=mock`. A missing state file stops the run.
- Writes: a new entry gets the next id across all kinds, the first current
  entry of a kind is preferred, a preferred entry takes the mark from the
  others of its kind, a phone gets `normalized_number`, an address `zip5`;
  an emptied addressee and salutation are rebuilt as LGL does (prefix,
  first, last, suffix). Every write stamps the constituent's `updated_at`.
- The state is written back after every write (about 7 MB; a backlog of a
  few hundred calls rewrites it a few hundred times, seconds in all).
- Smoke run: a dry full pass on a copy of a production pull printed the
  mock line and `lgl=mock`, and left the file unchanged.

## Why

@csmig wants to see what staff face after the service's first real run:
production data on both sides, every planned write carried out, and later
passes reading back what earlier passes wrote. Neither existing run does
that:

- **Rehearsal** (dev VG loaded from a production dump, production LGL read
  only): real data, but LGL writes are deferred. A deferred write leaves its
  pair `never-agreed`, so the next ordinary pass brings the holds back
  (56 after the reconcile pass on 2026-11-19).
- **Harness** (trial account, invented people): real writes, invented data.

The LGL API itself is proven against the trial account. This is **not**
about LGL's behaviour. The engineer's words: "simply to let the sync service
operate as though its writes occurred and that's what it sees on its next
read." A copy of production into the trial account was considered and
rejected: about an hour of rate-limited calls, new constituent ids to remap
in VG and in the import file, and real donor data in a second place.

## What to build

A mock LGL client, chosen by one setting (say `LGL_MOCK=<state file>`),
that stands in for `createLglClient` (`src/lgl-vg/lgl.js`) wherever
`main.js` builds one (four call sites today; one factory is better than
four checks).

- **Initial state:** a saved production pull. `report --save-snapshot`
  already writes one (`constituents` with addresses, emails and phones
  expanded, and `gifts`). Say how to start a state file from it.
- **Reads** answer from the state: `pullConstituents`, `pullGifts`,
  `getConstituent`, `constituentGifts`, `listEntries`, `getConstituentFull`,
  `constituentsSince`, `giftsSince`, `probe`. Keep the shapes the real API
  returns, which the sync already parses.
- **Writes** change the state: `patchConstituent`, `addEntry` (new entry
  id), `patchEntry` (including `not_current` and `is_preferred`). Every
  write stamps the constituent's `updated_at`, so the LGL check and the next
  pass's cursor see the sync's own writes come back as they would in real
  LGL.
- **Persistence:** the state is written back after each run (or each
  write), so separate `main.js` runs see each other's writes. Resetting is
  copying the starting snapshot again.
- **Safety:** with the mock set, the client makes no network call at all,
  and the run says so on its first line and its `PASS` line. Refuse to
  start with the mock set and no state file. The production-LGL guards stay
  as they are for non-mock runs.
- `--snapshot` refuses `--write-vg` because a snapshot is stale. A mock
  state is not stale (it is the LGL of the rehearsal), so mock runs
  accept `--write-vg --write-lgl`.

Your call: a mock client object, or a mock `fetchImpl` behind the real
client (the seam already exists and would exercise the real request code).
Say which, and why.

Out of scope: LGL's own behaviour (overnight address verification,
validation, refusals, rate limits). Optional, and only if cheap: a way to
make a staff-style edit in the state (one constituent's field), to see the
check pick it up.

## Order

1. Run the harness and merge `phones-list` (the dev VG rehearsal may be
   wiped; it is rebuilt from a dump).
2. Build the mock on a branch, with unit tests for each read and write and
   one test that a write is read back by the next pull and by
   `constituentsSince`.
3. Tell village-green-90 when it is ready. That session then runs the full
   rehearsal: dev VG reloaded from the newest dump, @csmig restarts the dev
   API, setup and role grant, `seed-import --write-vg`, a first pass with
   `--write-vg --write-lgl` and the allow-list at `all` against the mock,
   the reconcile pass (`POLICY_FILE=policy-reconcile.json`), then one or
   two ordinary passes. Expected: no deferred writes, and day-1 open holds
   around 71 (75 projected on `phones-list`, less the 4 that came from
   dev memory written under the old phone read).
