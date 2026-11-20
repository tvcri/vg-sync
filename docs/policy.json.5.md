# POLICY.JSON(5)

## NAME

policy.json — the customer's rules for what vg-sync does with each difference

## SYNOPSIS

```json
{
  "fields":   { "<field>": { "<case>": "<action>", ... }, ... },
  "records":  { "<record kind>": "<action>", ... },
  "settings": { "<setting>": "<value>", ... }
}
```

## DESCRIPTION

**vg-sync** compares each linked pair (a VG person and the LGL constituent
linked to it) field by field, and decides a *case* for each field (see
CASES). `policy.json` says what to do in each case: copy one side to the
other, or leave both alone and open a hold for staff.

The rules in this file are the customer's business rules. The engineer does
not choose them; a change should come from the customer and be recorded with
its date in `decided`. Every value the file leaves out means `hold`, the safe
default.

The file is read when a run starts. The service reads it once, at start-up,
so a change takes effect after a restart; a command run by hand reads it each
time. Each run row in VG records the SHA-256 of the exact text read
(`policyHash`), so it is always known which rules a run applied.

The path is `policy.json` in the working directory, or `POLICY_FILE`.

## FILE FORMAT

A JSON object with these keys. Any other key (such as `decided`) is ignored,
which is how notes are kept: JSON has no comments.

### fields

One entry per field, each mapping a case to an action. A field or case left
out is `hold`.

Fields:

| Field | What it is |
|---|---|
| `firstName`, `lastName`, `suffix`, `nickname` | Names |
| `address` | VG's one address; LGL's preferred current street address |
| `email` | VG's email; LGL's preferred current email |
| `phones` | VG's home and cell together; every current LGL phone, as a set. A copy to VG is held (`phones-no-slot`) when LGL has more than two. |
| `deceased` | The deceased mark, with its date |

### records

Rules for a whole linked donor, not a field.

| Kind | When | Actions |
|---|---|---|
| `lgl-missing` | The linked LGL constituent is gone from LGL (deleted, or merged away). | `unlink`: remove the donor link and open an `unlinked` notice per person; or `hold`. A merge whose surviving record can be found is followed instead, whatever this says. |
| `no-longer-donor` | The linked constituent is still in LGL but no longer counts as a donor. | `unlink` or `hold`. |

### settings

| Setting | Values | Default | Meaning |
|---|---|---|---|
| `couple-lgl-changed` | `to-vg`, anything else | hold | A change in LGL to a couple's shared field (address, email, phones) goes to both VG partners when `to-vg`; otherwise it is held. |
| `lgl-addressee` | `if-default`, `never` | `if-default` | When a name is written to LGL: `if-default` lets LGL rebuild the addressee and salutation if they are still LGL's default for the old name, and leaves hand-written ones (opening an `addressee` hold); `never` leaves them alone. |

## CASES

The sync remembers the value both systems last agreed on, so it can tell
which side changed.

| Case | Meaning | Policy consulted |
|---|---|---|
| `same` | The two agree. | No |
| `first-match` | They agree; nothing was remembered yet. The value is recorded. | No |
| `converged` | Both changed, to the same value. The value is recorded. | No |
| `lgl-changed` | LGL changed since they last agreed; VG did not. | Yes |
| `vg-changed` | VG changed since they last agreed; LGL did not. | Yes |
| `both-changed` | Both changed, to different values. | Yes |
| `never-agreed` | They differ and have never agreed (the state of most pairs at go-live). | Yes |
| `lgl-cleared` | LGL emptied a value they had agreed on. | Yes |
| `vg-cleared` | VG emptied a value they had agreed on. | Yes |

## ACTIONS

| Action | Fields | What it does |
|---|---|---|
| `hold` | any | Write nothing; open a hold whose reason is the case. |
| `to-vg` | any | Copy LGL's value to VG. An empty LGL value is copied too, emptying VG's field: use it on `never-agreed` only with care. |
| `to-lgl` | any | Copy VG's value to LGL. An empty VG value is held, never written. |
| `to-lgl-else-hold` | any | As `to-lgl`, but an empty VG value is held as `never-agreed`. Used for email. |
| `merge` | `phones` only | Fill each side from the other: a number only LGL has goes to an empty VG slot, one only VG has is added to LGL (LGL's phones are a list; any number of one type is fine). An LGL number with no free VG slot is held (`phones-no-slot`). Records no agreed value; the next run finds them agreeing. |
| `toward-deceased` | `deceased` only | Whichever side has the mark gives it to the other, with its date. Two marks with different dates are held. |
| `fill-blank` | any; `never-agreed` only | Fill only an empty side: LGL's value goes to VG where VG has none, VG's to LGL where LGL has none. Two different values are held as `never-agreed`, as `hold` would. An unclean LGL value is not empty: it is held `unclean`. |

`merge` and `toward-deceased` are accepted on any field by the file's
checks, but mean something only on the fields shown. `fill-blank` on any
case but `never-agreed` stops the run: on a cleared value it would undo the
clearing.

## WHAT THE POLICY CANNOT OVERRIDE

Some guards run whatever the file says. Each opens a hold with its own
reason:

- A malformed LGL value is never copied to VG (`unclean`); several
  candidate LGL addresses or emails for one field are never guessed
  between (`ambiguous`). Phones are a list and are never ambiguous.
- An emptied value is never written to LGL, and a deceased mark is never
  removed by the sync (`deceased-removed`).
- A first name from LGL that would drop VG's nickname is held
  (`lost-nickname`).
- A couple's first names are always held, and a couple's shared field is
  held when the partners disagree (`couple`).
- VG's address is not written over an LGL PO box (`po-box`).
- A field written to LGL by more than 3 runs in 30 days is held (`flapping`).
- A write VG or LGL refused is not tried again until the value changes
  (`vg-refused`, `lgl-refused`).
- LGL writes need `--write-lgl` or `WRITE_LGL=true` and a constituent on
  `LGL_WRITE_ALLOW`; otherwise a `to-lgl` decision is reported as deferred.

## VALIDATION

A file that is not valid JSON, names an unknown field, case, action, record
kind or record action, or gives `lgl-addressee` a value other than
`if-default` or `never`, stops the run before anything is read or written:
the service prints `STARTUP FAILED policy: ...`, a command `... FAILED
policy: ...`.

## FILES

`policy.json`
: The rules as they ship, from the customer's answers of 2026-11-12:

| Field | `lgl-changed` | `vg-changed` | `both-changed` | `never-agreed` | cleared |
|---|---|---|---|---|---|
| names (four fields) | `to-vg` | `to-lgl` | `to-lgl` | `hold` | `hold` |
| `address` | `to-vg` | `to-lgl` | `to-lgl` | `to-lgl` | `hold` |
| `email` | `to-vg` | `to-lgl` | `to-lgl` | `to-lgl-else-hold` | `hold` |
| `phones` | `to-vg` | `to-lgl` | `to-lgl` | `merge` | `hold` |
| `deceased` | `to-vg` | `to-lgl` | `to-lgl` | `toward-deceased` | `hold` |

Records: `lgl-missing` `unlink`, `no-longer-donor` `hold`. Settings:
`couple-lgl-changed` `to-vg`, `lgl-addressee` `if-default`.

In words: an edit in one system reaches the other; where both changed, VG
wins (LGL's value is kept in the log); addresses, emails and phones that
differ at go-live go from VG to LGL, a phone only LGL has comes to VG; names
that differ at go-live are listed for staff, not changed; clearing is never
copied.

## EXAMPLES

Have VG's nickname go to LGL when they have never agreed (a customer
decision, not yet made):

```json
"nickname": { "lgl-changed": "to-vg", "vg-changed": "to-lgl", "both-changed": "to-lgl", "never-agreed": "to-lgl" }
```

Where VG has a nickname and LGL has none, LGL is filled in. Where only LGL
has one, the pair is still held (an empty VG value is never written to LGL).
Where both have different ones, VG's replaces LGL's. Using `to-vg` here
instead would empty VG's nickname wherever LGL has none. To fill only a
blank side, in either direction, and hold the rest, use `fill-blank`.

Hold every change to email while something is investigated:

```json
"email": {}
```

`policy-reconcile.json`
: `policy.json` with `fill-blank` on `never-agreed` for the four name
fields, and nothing else changed. For the service's first full pass at
go-live only (`POLICY_FILE=policy-reconcile.json`, removed after it), so that a name only one system has
never reaches staff as a hold (the engineer, 2026-11-19). After that pass the
filled pairs are agreed, and `policy.json` holds a name cleared later as
before. Email is left out on purpose: a new VG email can put a person on
VG's mailings. The image carries both files.

## SEE ALSO

vg-sync(1) (`docs/vg-sync.1.md`); the sync design,
`docs/superpowers/specs/2026-11-11-lgl-vg-sync-design.md` ("The policy
file", "For the customer", "Guards").
