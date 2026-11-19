# Handoff: LGL phones as a list, not two slots

2026-11-19, from the Village Green session (holds UI, PR #158 in
`tvcri/village-green`). Board item VG-202611-521 (#153); commits end with
`Refs #153`.

## The problem

The 2026-11-19 rehearsal (production snapshot of 15:45, seed-import, a
standard pass, then the reconcile pass; VG writes only) leaves 88 open holds.
25 are `phones-no-slot`. In **18** of them the hold's own wording is false:

- VG has a Phone (A) and a Cell (B).
- LGL has one current number, B, typed **Home**.
- The set comparison sees {A, B} vs {B}: `never-agreed`, policy `merge`.
- Nothing from LGL needs a VG slot. VG's A should go to LGL as Home, but
  `phoneCalls` (`src/lgl-vg/lgl-calls.js`) skips a merge into a type group
  that already has a current entry. No call, so `plan.js` holds
  `phones-no-slot`.

So the hold says "no room" for a person whose LGL record has one number.
The other 7 are genuine: LGL has a number VG lacks and VG's two slots are
full (3 of these also have the shared number under different types).

| Shape | Holds |
|---|---:|
| VG Phone+Cell; LGL one number = VG's Cell, typed Home; VG's Phone not added | 18 |
| LGL number VG lacks; VG's two slots full | 7 |

## Why the write refuses

Not because of LGL. LGL allows any number of current numbers of one type.
The refusal protects the sync's own reader: `pick()` in
`src/lgl-vg/fields.js` maps each LGL type group to one VG slot (non-mobile →
Phone, mobile → Cell) and needs one entry per group (the preferred one, or
the only current one). LGL has one preferred number per constituent, so a
second current Home with the mark elsewhere reads as `ambiguous` and holds
the person's whole `phones` field.

Type therefore matters in two places and not the third:

- compare: no (numbers as a set);
- read: yes (one per type group);
- write: yes (to keep the read unambiguous).

## The engineer's position (@csmig, 2026-11-19)

> I'm fine if an LGL constituent has 2 phone numbers of the same type. It
> seems we're picking and choosing [when] type matters here. It doesn't for
> the list check, but it does for the write, and I disagree.

Several numbers of one type in LGL are normal, not a fault, and must not
stop the sync.

## What to build

Model LGL phones as **a list of current numbers**, compared as a set (as
today):

- **Read:** several current numbers of one type are not `ambiguous`. The
  `ambiguous` phone hold goes away, or is kept only for a case you can
  name that really can't be read.
- **Write to LGL (merge):** a VG number LGL lacks is added, typed from its
  VG slot (Phone → Home, Cell → Mobile), whatever is already in that type
  group. Never retire or retype an existing LGL entry in a merge. The
  preferred mark is left where it is, or set only when LGL has none.
- **Write to VG:** LGL numbers VG lacks still fill only an empty VG slot;
  VG keeps two. An LGL number with no VG slot is still a `phones-no-slot`
  hold. That's the 7, and the only case the reason should now mean.
- **Which LGL numbers fill VG's slots** (from LGL to VG, and for a copy on
  `lgl-changed`) needs a rule now that a type group can hold several. It's
  your call; say what you chose. One candidate: preferred first, then by
  type, then the most recently added.
- The memory's `phones` row and the LGL check (`check.js`, the own-write
  echo) must agree with the new read, or the first pass after a write sees
  its own number as a change.

Out of scope: retyping LGL's existing entry to match VG (proposed earlier
in the VG session, not needed once the write stops refusing).

## Checks

- Unit tests in `test/lgl-vg/` for the shapes above, including two current
  Home numbers with the preferred mark on a Mobile, and with no mark.
- Rerun the rehearsal as `docs/handoff-2026-11-16-go-live.md` describes
  (standard pass, then the reconcile pass). Expect the 18 to plan an LGL
  add (deferred on a VG-only run) instead of a hold. Report the new open
  count: about 70 if only these change.
- The trial account (`.env.trial`) is where an add into an occupied type
  group can be tried against real LGL.

## VG side (not for this repo)

The screen's sentence for `phones-no-slot` ("LGL has more numbers than VG
has room for") is wrong for the 18. Once this change lands the reason
means only "an LGL number with no VG slot", and the sentence becomes right.
If this change does not land, VG's wording has to change instead. Tell the
VG session which.
