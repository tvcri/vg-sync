# LGL ↔ VG Step 4: Unlinked Donors — Implementation Plan

> **For agentic workers:** steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The full pass links or creates a VG person for every LGL donor
with no link, holds anything else with a reason, removes the Donor mark from
a person whose constituent is gone from LGL (or follows it to the record
that replaced it), and leaves alone every donor the import's review decided
to skip. A one-time `seed-import` command loads those decisions.

**Spec:** `docs/superpowers/specs/2026-11-11-lgl-vg-sync-design.md`, sections
"Unlinked donors", "The policy file" (`unlink`), "Holds on fields", "A full
pass" (steps 5 to 7), "For the customer" (question 5). Harness:
`docs/superpowers/specs/2026-11-13-test-harness-design.md`.

**Board:** VG-202611-521 (#153 in `tvcri/village-green`). Commits end with
`Refs #153`.

## Global constraints

- Public repo: every name, address, email, phone and id in code, tests,
  scenarios, docs and commit messages is invented. The import's decisions
  file holds real ids and names; the code reads it from a path given on the
  command line and never copies a value from it.
- Dry by default. Without `--write-vg` nothing is written to VG.
- Nothing writes to LGL.
- Node 24 built-ins only.

## Rulings made while writing this plan

Each goes into the design (Task 9), marked **(call)**.

1. **Unlinked holds are keyed by constituent.** A hold from matching has
   `personId: null` and `field: null`, so a donor has at most one at a time,
   whatever its reason. Its fingerprint is built from the reason, the VG
   people it matched (sorted ids) and LGL's last gift date. A rule dismissal
   is therefore reconsidered when a new gift arrives or the candidates
   change, as the design asks.
2. **A staff dismissal leaves the donor alone.** A constituent with a
   dismissed hold of kind `staff` and no `personId` is not matched at all:
   no link, no create, no new hold. It still counts in the near-duplicate
   test, so it cannot let a look-alike through.
3. **The seed.** `node src/lgl-vg/main.js seed-import --file <import-*.json>
   [--write-vg]` reads the import's run file (`lgl-import/out/import-prod-*.json`),
   one hold per constituent:
   - staff chose Skip → dismissed, kind `staff`, reason `import-skip`;
   - skipped for an old last gift → dismissed, kind `rule`, reason
     `before-horizon`, with the fingerprint matching would give it, so it
     stays dismissed until its facts change;
   - skipped as "Anonymous" → dismissed, kind `rule`, reason `anonymous`;
   - **held by the import** (never confirmed by staff, or two LGL rows
     pointing at one VG person) → **open**, reason `import-hold`. The design
     said "dismissed"; these were never decided, and a dismissed row would
     hide them from the count staff will see. The sync leaves the donor
     alone while the hold is open, and closes it once the donor is linked
     (by hand) or is no longer an unlinked donor.
   - Where a couple's two rows differ, the strongest wins: `import-skip`,
     then `import-hold`, then the rule reasons.
   - A constituent that already has a hold with one of these reasons, or is
     linked in VG today, gets nothing. Running it twice adds nothing.
4. **Create is logged with a hold.** `sync_log` is for LGL writes only
   (step 3 ruling). A create opens a `create-unfinished` hold (person and
   constituent) after `POST /persons` and before the donor row, and closes
   it after the donor row is written. A later pass that finds that hold
   open finishes the link if the person still has no donor row and its first
   and last names still match; otherwise the hold stays open. A link removed
   later by staff is not re-made by this path.
5. **A created person's memory is written before its donor row**, one row
   per field: LGL's cleaned value, or null for a field empty in LGL. A field
   LGL holds but could not clean (unclean or ambiguous) is left out of the
   person and gets no memory; the next pass holds it as usual.
6. **Linked and created pairs are compared on the next pass**, not in the
   pass that links them.
7. **`unlink` is built, and follows a merge.** `lgl-missing` with policy
   `unlink`: if exactly one unlinked donor matches the person by email and
   name (the person treated as having no donor row), the donor row is
   pointed at that constituent in one `PUT` ("followed"); otherwise the
   donor row is deleted and an `unlinked` hold (person and constituent) is
   opened for staff. That hold closes when the person is a donor again. A
   couple's record is never followed (matching holds couple names), so both
   partners are unlinked. Whether LGL's merge leaves anything the API can
   see is still for the engineer to try in the LGL screen; until then a
   merge is taken to look like a deletion, and the harness simulates one
   that way.
8. **Re-read before link, create, finish and unlink.** One fresh read of
   all VG people after the linked pairs' writes; matching is run again on
   it, and a link, create or finish whose decision changed is skipped as
   stale. An unlink or follow re-reads the persons linked to the old
   constituent.
9. **A refused link or create** opens a `vg-refused` hold with no
   `personId`, fingerprinted like rule 1; matching does not try it again
   while that hold is open or dismissed with the same fingerprint.
10. **Who owns which hold.** Step 4 owns: holds with no `personId` whose
    reason is a matching reason, `import-hold` or `vg-refused`; and
    `create-unfinished` and `unlinked` holds. It closes only those. Step 3's
    ownership is unchanged.
11. **The circuit breaker counts links, creates, finishes and unlinks** as
    people changed (a create counts once, by constituent).
12. **Harness.** The step 3 scenario `deleted-lgl-constituent-unlink-is-deferred`
    is retired (its step 4 twin replaces it); `--step` defaults to 4; a
    scenario with no VG person of its own is checked against the people
    linked to its constituent; new scenario key `importDecision` makes the
    runner write an import-format file for those scenarios and run the real
    `seed-import --write-vg` after seeding; `expect.vg.donorOf` names the
    scenario whose constituent the person must be linked to.

## Tasks

### Task 1: Matching returns candidates and honors exclusions — `match.js`

- `matchUnlinked(donors, persons, { today, horizonYears, exclude })`:
  every hold decision carries `candidates` (sorted ids of the VG people
  found by email, name or address); donors in `exclude` (a Set of
  constituent ids) get `{ outcome: 'skip', reason: 'left-alone' }`, are left
  out of pass 1 and stay in pass 2's look-alike set.
- Export `MATCH_REASONS` and `unlinkedFingerprint(reason, candidates, lastGiftDate)`.
- Tests: candidates on `name-only` and `already-linked-elsewhere`; an
  excluded donor neither links nor makes another donor's link a duplicate;
  an excluded look-alike still holds a create.

### Task 2: Plan for unlinked donors — `src/lgl-vg/unlinked.js` (pure)

`planUnlinked({ constituents, gifts, persons, holds, unlinking, config, today })`
→ `{ decisions, links, creates, finishes, holds, counts }`.

- Unlinked donors: pass the donor rule, no person links to them, not an org.
- `unlinking`: Map personId → old constituent id; those persons are matched
  as if they had no donor row. A link onto one of them becomes a follow.
- Left alone (rule 2, rule 3's `import-hold`), pending finishes (rule 4).
- Links: `{ personId, constituentId, lastGiftDate, follows? }`. Creates:
  `{ constituentId, body, address, agree, lastGiftDate, fingerprint }`, body
  from `lglFields` (null and problem fields left out). Finishes: `{ holdId,
  personId, constituentId, lastGiftDate }`.
- Desired holds for every other outcome, plus open `import-hold`,
  unfinishable `create-unfinished`, and `unlinked` holds whose person is
  still not a donor.
- A link or create matching a `vg-refused` hold (rule 9) becomes that hold.
- Decisions: `kind: 'unlinked'`, `outcome` `write-vg` (action `link`,
  `follow`, `create`, `finish`), `hold`, or `skip`.
- Tests for each row of the design's table, the three duplicate rules, the
  exclusions, a follow, a refused create, and finishing.

### Task 3: `planLinked` emits unlinks

`lgl-missing` (and `no-longer-donor`) with action `unlink` produce
`plan.unlinks: [{ personId, constituentId, reason }]` and a decision with
outcome `write-vg`, action `unlink`, instead of `deferred`.

### Task 4: Hold ownership — `holds.js`

`reconcileHolds(desired, existing)` closes an open hold only if step 3 or
step 4 owns it (rule 10). Tests: an open `name-only` hold with no person is
closed when not desired; an `import-skip` dismissed hold is never touched;
an open `unlinked` hold is closed when not desired.

### Task 5: VG client

`createPerson(body)` (`POST /persons`), `deleteDonor(personId)`
(`DELETE /persons/{id}/donor`, 204 with no body).

### Task 6: Apply — `apply.js`

After the linked pairs' writes and before memory and holds:
unlinks and follows (re-read the old constituent's people), then one
`listPersons` and a fresh `planUnlinked` (rule 8), then links, finishes and
creates. A create: town lookup, `POST /persons`, open `create-unfinished`,
`PUT /sync/fields` for the new person, `PUT` donor, close the hold.
Refusals as rule 9; anything else fails the pass.

### Task 7: The pass and the command

`pass.js` plans both, applies the follow-over of unlinks, counts people for
the breaker, adds `links`, `creates`, `unlinks` to the `PASS` line and the
run row. `main.js` gains `seed-import` (rule 3), with the pure part in
`src/lgl-vg/seed.js`.

### Task 8: Harness

Rule 12, plus scenarios in `harness/scenarios/unlinked.js` (`since: 4`),
one per row of the design's table and rule above. Run the step 4 set until
it passes, then the full set.

### Task 9: Design, handoff, dry run

- Rulings into the design; "Left to the builder" and question 5 updated.
- A dry run of `seed-import` and `full` against a restored production
  snapshot of VG and production LGL reads; counts read back masked.
- Handoff for step 5.
