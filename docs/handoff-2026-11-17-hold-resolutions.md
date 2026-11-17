# Handoff: staff resolutions for unlinked donors (2026-11-17)

For the next session in this repo. Board item VG-202611-521 (#153 in
`tvcri/village-green`); commits end with `Refs #153`.

Follows `handoff-2026-11-17-holds-ui.md`. That note asked whether unlinked
holds need an action rather than just a dismissal. The engineer's answer:
yes. Leaving a donor unlinked forever because only a person knows who they
are is a design weakness of the sync. Staff will submit the answer through
VG, and **the sync carries it out.**

VG's side is designed in
`~/dev/village-green/scratch/superpowers/specs/2026-11-17-sync-holds-ui-design.md`
(section "Resolution contract"). This note restates what the sync needs. The
VG side has not been built yet. The order is: this repo first, then VG in one
PR.

## Status (2026-11-17, end of day)

The sync's half is built on branch `hold-resolutions` (unmerged, unpushed).
The design spec's "Staff resolutions" section records the rules as built.
Unit tests pass. A dry full pass against production LGL and the 2026-11-17
production snapshot leaves day 1 at 152 open holds; 197 existing unlinked
holds would gain `detail.lgl`. The harness scenarios
(`harness/scenarios/resolutions.js`, 4 of them) passed against a dev API
temporarily patched to return the four columns. That patch is reverted and
the columns dropped from the dev database, so those scenarios fail until
VG's PR is in the dev API. Notes for VG's side:

- A schema property of any JSON (as `resolution` is) is declared like
  `detail`, with a description and no `nullable`: ajv rejects `nullable`
  without `type`, and every `GET /sync/holds` then answers 500.
- The sync reads `resolution` and `resolvedAt` (the latest resolution on a
  donor wins); it ignores `resolvedUserId` and `closedUserId`.
- It closes a resolved hold through `PATCH /sync/holds` (open → closed),
  whatever its reason, and sends closes before creates.

## The decision

Of the two approaches considered, the engineer picked A (2026-11-17):

- **A. Staff record the answer on the hold; the sync carries it out.** Every
  LGL→VG write stays in the sync, and both answers are covered. The cost is
  one pass of delay.
- **B. VG links the donor itself.** Rejected. It splits link ownership, and
  it cannot create a person, because VG doesn't have LGL's record.

## What VG will add

**`sync_hold` columns** (VG migration 0034). Until it exists, add them by
hand to the dev and harness databases:

```sql
ALTER TABLE sync_hold
  ADD COLUMN resolution json NULL AFTER note,
  ADD COLUMN resolvedAt datetime(3) NULL AFTER resolution,
  ADD COLUMN resolvedUserId int NULL AFTER resolvedAt,
  ADD COLUMN closedUserId int NULL AFTER resolvedUserId;
```

- `resolution`: `{"kind":"link","personId":"123"}` or `{"kind":"create"}`.
- `GET /sync/holds` returns all four fields; the values are null when unset.
- `closedUserId` is set only when a person closes a hold, which happens only
  to `addressee` and `lgl-incomplete`. The sync never sets it.

**Staff endpoint** `POST /sync/holds/{holdId}/resolution`, with body
`{ kind, personId?, note? }`. VG enforces these rules before a resolution
ever reaches the sync:

- The hold has no `personId`. It is either open, or dismissed with
  `dismissalKind: 'staff'`. Resolving a dismissed hold **reopens** it, with
  the resolution set.
- The kinds allowed depend on the reason:
  - **link and create:** `name-only`, `multiple-matches`,
    `shared-email-different-name`, `same-address-last-name`,
    `duplicate-in-lgl`, `import-hold`, `import-skip`, `resolution-failed`.
  - **link only:**
    - `already-linked-elsewhere`, to someone other than the linked
      candidate.
    - `before-horizon`: creating would override the horizon policy, but
      linking to an existing person does not.
  - **neither:** `anonymous`, `deceased-in-lgl`, `couple-name`,
    `no-last-name`.
- For a `link`, the person exists and has no donor record.
- While the hold is open, staff can replace the resolution.

**Staff endpoint** `POST /sync/holds/{holdId}/closure`. It closes an open
`addressee` or `lgl-incomplete` hold (`closedAt`, `closedUserId`). This is no
change for the sync, which already never closes those two. Confirm that a
person-closed one is not reopened unless a new LGL write causes a new one.

## What the sync must do

1. **Carry out resolutions.** In step 4 (`unlinked.js`), an open hold with
   no person and a non-null `resolution` is a decision, not a match. Take
   its constituent out of matching and:
   - `link`: write the donor link to `resolution.personId` exactly as a
     matcher link is written (`lastGiftDate`, fingerprint, log).
   - `create`: build the person with `createBody` exactly as a matcher
     create (memory rows, the `create-unfinished` safety net).
   - Then close the hold. `reconcileHolds` must not close or replace a
     resolved hold just because the matcher's own reason for that
     constituent has changed.
2. **Re-check the resolution at pass time.** VG validated it when staff
   submitted it, but things can change before the pass. If it cannot be
   done:
   - the person is gone,
   - the person is now linked to another constituent,
   - the constituent is no longer a donor, or has gone from LGL,
   - VG refuses the create,

   then close the resolved hold and open a hold with reason
   **`resolution-failed`** (`personId` null). Its detail is
   `{ resolution, message, lgl }`, where `message` is one plain sentence for
   staff, such as "Doe, Jane is already linked to another LGL donor."
   Add `resolution-failed` to the step-4 reasons (`UNLINKED_REASONS`) so the
   step owns it. Staff can resolve it again.
3. **Respect staff exclusion as before, with one change.** A staff-dismissed
   unlinked hold still excludes its donor from matching. A *resolved* one
   (VG reopened it) is handled by rule 1 instead.
4. **Say who the donor is.** Every unlinked-donor hold's `detail` gains
   `lgl: { name, email, address, lastGiftDate }`. These are display strings,
   and any of them may be null:
   - `name`: LGL's name as staff would read it.
   - `address`: the preferred current address on one line.

   This includes carried-over `import-hold`s: refresh their detail when the
   pass sees them. Check whether changing the detail changes the
   fingerprint, and whether that matters. Today the screen has nothing but a
   constituent id to show.
5. **Tolerate VG without the columns.** Until VG's PR is merged and in
   production, `GET /sync/holds` has no `resolution` field. Treat a missing
   field as null. This lets the sync deploy before VG, as the engineer chose.

## Testing

- Unit tests in step 4 for:
  - link and create resolutions
  - each failure in rule 2
  - a resolution on a reopened staff dismissal
  - a resolved hold that the matcher would now hold for a different reason
- Harness scenarios: write `resolution` straight into the dev `sync_hold`
  (VG's endpoint doesn't exist yet), run a pass, and check the link or the
  new person and the closed hold.
- A dry full pass against the production snapshot: the 7 day-1 unlinked
  holds should now carry `detail.lgl`.

## Out of scope here

- Field holds are unchanged. The customer's questions about nicknames and
  phones are still open (see the holds-UI handoff).
- VG's UI, endpoints and migration are built in `~/dev/village-green` after
  this.
