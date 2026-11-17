# Handoff: a UI for the sync's holds (2026-11-17)

For whoever picks up the holds UI in `~/dev/village-green`. The sync
(this repo) already writes holds to VG's `sync_hold` table; nothing in the
app shows them yet. This note says what a hold is, how many to expect, what
the app has today, and the decisions still open. It is not a design.

## Why this matters

The customer's staff are not technical. On go-live they will face a list of
things the sync left alone, and each item needs to read as a plain
situation with a plain next step. The sync distinguishes about 35 reasons;
staff should see about six. The UI does the translating; the reason codes
stay underneath.

## What a hold is

A row in `sync_hold`: the sync found something it will not decide alone, or
something staff should know. Columns that matter to a UI:

| Column | Meaning |
|---|---|
| `lglConstituentId`, `personId` | The LGL record and the VG person. `personId` is empty for an LGL donor not linked to anyone. |
| `field` | The detail in question (`firstName`, `address`, ...), or empty for a whole-record hold. |
| `reason` | Why (the codes below). |
| `detail` | JSON, shaped by the reason. Field holds carry `vg`, `lgl`, `case`, `agreed`; LGL-write holds carry the attempted call; unlinked holds carry `candidates` (VG person ids). |
| `state` | `open`, `closed` or `dismissed`. |
| `dismissalKind`, `dismissedAt`, `dismissedUserId`, `note` | Who dismissed it and why. |
| `firstSeenAt`, `lastSeenAt` | When the sync first and last found it. |

How it moves:

- The sync closes most holds itself once the cause goes away (the two sides
  agree again, the rule now gives an action).
- `addressee` and `lgl-incomplete` are never closed by the sync: a person
  closes them, after doing something in LGL.
- A dismissed field hold stays dismissed until either value changes, then
  reopens. A dismissal loaded from the import's review is permanent.
- Couples get one row per partner.

## The reasons, in staff terms

A first cut at the grouping. The wording is a proposal, not tested with
staff.

| Staff sees | Reasons | What staff can do |
|---|---|---|
| The two systems disagree on a detail | `never-agreed`, `both-changed`, `lgl-cleared`, `vg-cleared`, `lost-nickname`, `deceased-removed`, `phones-no-slot` | Correct it in one system (the sync copies it), or mark it seen |
| A couple shares one LGL record | `couple` | Mark it seen |
| An LGL donor might be someone in VG | `name-only`, `multiple-matches`, `shared-email-different-name`, `same-address-last-name`, `already-linked-elsewhere`, `duplicate-in-lgl`, `import-hold` | Pick the person, or say "new person" (no endpoint does this yet) |
| An LGL donor the sync will not add | `anonymous`, `deceased-in-lgl`, `couple-name`, `no-last-name`, `before-horizon` | Usually nothing; mark it seen |
| A donor changed status | `no-longer-donor`, `unlinked` | Read; act in LGL if it is wrong |
| Something to finish in LGL | `addressee` (envelope name left hand-written), `lgl-incomplete` (an old entry may still be current), `po-box` | Fix it in LGL, then close it |
| For the engineer | `unclean`, `ambiguous`, `vg-refused`, `lgl-refused`, `flapping`, `create-unfinished` | Nothing; the engineer is told |

`README.md` and the sync design (`docs/superpowers/specs/2026-11-11-lgl-vg-sync-design.md`)
have the exact rule for each reason.

## How many to expect

From the production dry run of 2026-11-16, adjusted for the import's
decisions that `seed-import` loads before go-live. Derived, not observed: a
dry run on a restored snapshot with the decisions loaded would confirm it.

- **About 145 open field holds**, all on donors the import *linked* to an
  existing VG person. The import only added the Donor link to those people;
  nobody has compared their details before. Of those: 93 name holds (63
  nickname, 30 first name), 25 phones with no free slot, 10 couple first
  names (5 couples), 5 PO boxes, 6 for the engineer, 6 others.
- **About 5 open unlinked holds**: the import's 4 open holds, carried over,
  and one donor new since the import. Some 195 others load already
  dismissed (staff skips and horizon skips) and stay out of sight.

62 of the 63 nickname holds are one system blank and the other filled, not
a disagreement. A customer answer can remove them (see Open questions).

## What the app has today

- **Permissions** (`api/source/utils/permissions.js`): `sync:read` and
  `sync:write` exist. Only Admin (wildcard) and the Sync Service role hold
  them. The Staff role has `donor:read` but not `sync:read`.
- **Endpoints** (`api/source/specification/village-green.yaml`, tag Sync):
  - `GET /sync/holds?state=&personId=&lglConstituentId=` (`vg:sync:read`).
  - `POST /sync/holds/{holdId}/dismissal` with `dismissalKind` (`vg:sync`).
    Its text says "A staff dismissal is permanent"; the sync's rule is that
    a dismissed field hold reopens when a value changes. The code already
    allows that; only the text is wrong (noted 2026-11-14).
  - `POST` and `PATCH /sync/holds` are the sync's own; not for a UI.
  - The browser's `vg` scope passes these scope checks (prefix match); the
    permission is what gates them.
- **Person detail**: the donor section and the Donor tag
  (`client/src/shared/components/PersonDetailCard.vue`) show the link and the
  last gift date when the user has `donor:read`.
- **The hub** (`client/src/features/MetaVillage/components/MetaVillage.vue`,
  route `/meta`): sections Constituents (Persons, Trainings, Positions),
  Operations (Service Requests, Friends), Office (Mailing Labels), Reporting
  (Metrics), Advocacy (coming soon). Each action can be gated by a
  permission. The Admin hub (`features/Admin/components/AdminHub.vue`) is
  for access and catalogs.

## Where it could go

To decide. Options, not exclusive:

1. **A hub action under Constituents**, "Sync holds" or "From LGL", gated
   by a permission. Staff already go there for people.
2. **A new hub section**, "Donors" or "LGL", with the holds list and later
   any donor tools. Fits if more donor work is coming; one action alone
   makes a thin section.
3. **On the person**: a line in the donor section of the person detail when
   that person has open holds ("2 details differ from LGL"), linking to them.
   This is where staff will notice a hold while doing other work.
4. **Admin hub, for the engineer's reasons only**: `unclean`, `refused`,
   `flapping` and the like are not staff work.

A likely shape: 1 or 2 for the list, 3 for the per-person hint, 4 later if
the engineer wants it in the app at all.

## Open questions

For the engineer:

- **Who sees and dismisses holds.** Granting `sync:read`/`sync:write` to
  Staff would also let them write the sync's memory and log. A narrower
  permission (say `sync:hold_read`, `sync:hold_dismiss`) and an endpoint
  that only dismisses would keep the sync's tables to the sync.
- **Unlinked holds need an action, not just a dismissal**: "this is person
  X" or "create a new person". No endpoint does that; the sync's matcher
  would have to respect it (as it respects the import's staff decisions).
- **Whether the UI reads `detail` per reason** or the API adds a plain
  summary per hold.

For the customer (business rules; collect, do not decide):

- When only one system has a nickname (or first name, or suffix), should
  the sync fill in the blank side? Today it holds. A yes removes about 62
  of the 93 name holds, as a new setting with today's behaviour as default.
- Should phone numbers with no free slot in VG (25 holds) stay with staff,
  or should one rule decide which number VG keeps?
- Who receives the list, and how often ("How held items reach staff" in
  the sync design is still open).

## Also found: the Delete button on a donor

Viewing a donor in VG, the Delete button is enabled, and clicking it fails
with "Failed to delete person". `canDelete` in
`client/src/features/PersonList/components/PersonDetail.vue` checks member
and volunteer records but not the donor record; the API refuses a person
with any of the three. The fix: add the donor record to `canDelete`, say in
the tooltip that donor links come from LGL and cannot be removed in VG, and
show the API's 422 message instead of the generic toast (the API also
refuses a person still named on service requests). A user without
`donor:read` cannot see the donor record, so the button would still fail for
them. Whether a person is a donor is decided by LGL alone (the engineer,
2026-11-14).

## Seeing holds while building

`npm run harness -- --seed-only` (this repo) seeds a few invented people in
the dev VG and the LGL trial account and runs one pass; the couple gives two
open `couple` holds at once. Every reseed gives Admin to the dev login
`HARNESS_VG_ADMIN_USER` (default `manual`). Edits on either side, with the
service running (`WRITE_VG=true WRITE_LGL=true node src/lgl-vg/main.js --env
.env.harness`), open and close more. The harness scenarios
(`harness/scenarios/*.js`) produce most reasons; these have none (unit
tests only): `both-changed` (no rule holds it today), `vg-cleared`,
`lost-nickname`, `multiple-matches`, `anonymous`, `no-last-name`,
`lgl-incomplete`, `ambiguous`, `create-unfinished`. For a screen with every
reason, insert rows into the dev `sync_hold` by hand.
