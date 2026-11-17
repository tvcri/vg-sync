// Staff resolutions (docs/handoff-2026-11-17-hold-resolutions.md): staff answer an unlinked donor's
// hold in VG ("this is person X", "a new person") and the next pass carries it out, or opens
// resolution-failed. The edit writes the resolution straight into the dev sync_hold until VG has
// its endpoint, and VG's GET /sync/holds must return the resolution column. Every name here is
// invented and unusual on purpose.
import { GIFT, agreeing, lglConstituent, vgPerson } from '../people.js'

const town = { city: 'Zzyzxford', state: 'RI', zip: '00901' }
const held = (reason, state) => [{ field: null, reason, ...(state ? { state } : {}) }]

const linkAnswer = { first: 'Hesper', last: 'Quillingham', street: '4 Brackenhythe Row', ...town, email: 'hesper.quillingham@example.org' }
const createAnswer = { first: 'Corisande', last: 'Mallowfeld', street: '15 Thornwick Close', ...town, email: 'mallowfeld.household@example.org' }
const failAnswer = { first: 'Peregrine', last: 'Ashcolm', street: '22 Wyvernlea Road', ...town, email: 'ashcolm.household@example.org' }

export default [
  {
    name: 'staff-link-resolves-a-name-only-hold',
    why: 'Staff resolutions, link: a donor held name-only (the VG person has another email) is linked to that person once staff say "this is them", and the hold closes. The pair is compared on the next pass, as any new link is.',
    since: 4,
    link: false,
    ...agreeing(linkAnswer, { vg: { email: 'h.quillingham.old@example.org' } }),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, vg: { donor: false }, holds: held('name-only') } },
      { edit: { resolve: { kind: 'link' } }, run: 'full', expect: { writes: 1, vg: { donor: true, lastGiftDate: '-60d' }, holds: [] } },
    ],
  },
  {
    name: 'staff-create-resolves-a-shared-email-hold',
    why: 'Staff resolutions, create: a donor held because a VG person of another first name shares the household email is created as a new person once staff say so; the VG person who shares the email is left as they are.',
    since: 4,
    link: false,
    vg: vgPerson({ ...createAnswer, first: 'Barnabas' }),
    lgl: lglConstituent(createAnswer),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, vg: { donor: false }, holds: held('shared-email-different-name') } },
      { edit: { resolve: { kind: 'create' } }, run: 'full', expect: { writes: 1, vg: { donor: false }, holds: [] } },
      { run: 'full', expect: { writes: 0, holds: [] } },
    ],
  },
  {
    name: 'staff-skip-resolved-as-a-new-person-is-created',
    why: 'Staff resolutions on a staff decision: a donor staff chose to Skip in the import review is left alone until staff change their mind. Resolving the dismissed import-skip hold reopens it with the answer, the person is created, and the hold closes.',
    since: 4,
    link: false,
    importDecision: 'staff-skip',
    lgl: lglConstituent({ first: 'Ottilie', last: 'Frogmorley', street: '9 Larkspurrow Lane', ...town, email: 'ottilie.frogmorley@example.org' }),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: held('import-skip', 'dismissed') } },
      { edit: { resolve: { kind: 'create' } }, run: 'full', expect: { writes: 1, holds: [] } },
      { run: 'full', expect: { writes: 0, holds: [] } },
    ],
  },
  {
    name: 'staff-link-to-a-person-linked-elsewhere-fails',
    why: 'Staff resolutions, a failure: staff link a held donor to a person who is by then linked to another LGL donor (the one unlinked-donor-matching-email-and-name-is-linked links in its first pass). The resolved hold closes, resolution-failed opens, and it stays open, keeping the donor out of matching, until staff answer again.',
    since: 4,
    link: false,
    vg: vgPerson({ ...failAnswer, first: 'Ignatia' }),
    lgl: lglConstituent(failAnswer),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: held('shared-email-different-name') } },
      { edit: { resolve: { kind: 'link', to: 'unlinked-donor-matching-email-and-name-is-linked' } }, run: 'full', expect: { writes: 0, vg: { donor: false }, holds: held('resolution-failed') } },
      { run: 'full', expect: { writes: 0, holds: held('resolution-failed') } },
    ],
  },
]
