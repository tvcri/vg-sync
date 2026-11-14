// Unlinked donors (step 4): an LGL donor with no VG link is linked, created or held; the import
// review's decisions are not undone. Every name here is invented and unusual on purpose, so that
// matching meets only the people a scenario means it to (the generator's 301 people are in VG too).
import { GIFT, address, agreeing, lglConstituent, vgPerson } from '../people.js'

// A town and ZIP that do not exist: LGL's address verification (about eleven minutes after seeding)
// matched made-up streets in a real town to real ones and rewrote them, city and ZIP included.
const town = { city: 'Zzyzxford', state: 'RI', zip: '00901' }
const lgl = (p) => ({ lgl: lglConstituent(p) })
const held = (reason, state) => [{ field: null, reason, ...(state ? { state } : {}) }]

const linkMe = { first: 'Odalys', last: 'Brackenridge', street: '7 Gorsewick Row', ...town, email: 'odalys.brackenridge@example.org', phone: '401-555-0401' }
const newDonor = { first: 'Perpetua', last: 'Wincanton', street: '19 Saltmarrow Lane', ...town, email: 'perpetua.wincanton@example.org', phone: '401-555-0402', cell: '401-555-0403' }
const nameOnly = { first: 'Leopold', last: 'Farthingdale', street: '3 Quillmere Court', ...town }
const household = { first: 'Rosalind', last: 'Pemberwick', street: '41 Ivelcombe Road', ...town, email: 'pemberwick.household@example.org' }
const sameHouse = { street: '14 Tansyford Lane', ...town }
const merged = { first: 'Evander', last: 'Hollowcrane', street: '8 Brindlemoor Way', ...town, email: 'evander.hollowcrane@example.org' }
const twice = { first: 'Isolde', last: 'Marrowfield', street: '27 Copperdene Street', ...town, email: 'isolde.marrowfield@example.org' }

export default [
  {
    name: 'unlinked-donor-matching-email-and-name-is-linked',
    why: 'Unlinked donors, Link: exactly one VG person matches on both email and name, and is no donor, so the donor row is written with LGL\'s last gift date. The pair has no memory, so the next pass records every field as agreed; the one after has nothing to do.',
    since: 4,
    link: false,
    ...agreeing(linkMe),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 1, vg: { donor: true, lastGiftDate: '-60d' }, holds: [] } },
      { run: 'full', expect: { writes: 0, records: 8, holds: [] } },
      { run: 'full', expect: { writes: 0, records: 0, holds: [] } },
    ],
  },
  {
    name: 'new-donor-is-created-with-agreed-memory',
    why: 'Unlinked donors, Create: no VG person shares the email, the name, or the last name at the house. The person is created from LGL\'s cleaned values with the donor row, and recorded as agreed on every field, so the next pass writes and records nothing.',
    since: 4,
    link: false,
    ...lgl(newDonor),
    gifts: [GIFT],
    phases: [
      {
        run: 'full',
        expect: {
          writes: 1, holds: [],
          vg: { firstName: newDonor.first, lastName: newDonor.last, address: address(newDonor), email: newDonor.email, phones: { phone: newDonor.phone, cell: newDonor.cell }, donor: true, lastGiftDate: '-60d' },
        },
      },
      { run: 'full', expect: { writes: 0, records: 0, holds: [] } },
    ],
  },
  {
    name: 'name-only-match-is-held-until-the-email-matches',
    why: 'Unlinked donors, Hold: a VG person with the same name but another email is not linked (name-only). When staff correct the email in VG the match is clean, the hold closes and the donor is linked.',
    since: 4,
    link: false,
    ...agreeing({ ...nameOnly, email: 'leopold.farthingdale@example.org' }, { vg: { email: 'l.farthingdale.old@example.org' } }),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, vg: { donor: false }, holds: held('name-only') } },
      { edit: { vg: { email: 'leopold.farthingdale@example.org' } }, run: 'full', expect: { writes: 1, vg: { donor: true }, holds: [] } },
      { run: 'full', expect: { writes: 0, holds: [] } },
    ],
  },
  {
    name: 'shared-email-different-name-is-held',
    why: 'Unlinked donors, Hold: a household email shared with a VG person of another first name is neither linked (a different person) nor created (it could be the same one under a nickname).',
    since: 4,
    link: false,
    vg: vgPerson({ ...household, first: 'Ignatius' }),
    lgl: lglConstituent(household),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, vg: { donor: false }, holds: held('shared-email-different-name') } },
      { run: 'full', expect: { writes: 0, holds: held('shared-email-different-name') } },
    ],
  },
  {
    name: 'same-house-same-last-name-is-held',
    why: 'Unlinked donors, Create: the last name at the same house number and ZIP as a VG person blocks a create (a spouse or the same person under another name and email).',
    since: 4,
    link: false,
    vg: vgPerson({ first: 'Cordelia', last: 'Ashgravel', ...sameHouse, email: 'cordelia.ashgravel@example.org' }),
    lgl: lglConstituent({ first: 'Barnaby', last: 'Ashgravel', ...sameHouse, email: 'barnaby.ashgravel@example.org' }),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, vg: { donor: false }, holds: held('same-address-last-name') } },
    ],
  },
  {
    name: 'old-last-gift-is-held-then-a-new-gift-creates',
    why: 'Unlinked donors, Create: a donor whose last gift is before the horizon (five years) is held, not created. A new gift changes the facts: the hold closes and the person is created.',
    since: 4,
    link: false,
    ...lgl({ first: 'Thessaly', last: 'Grimsditch', street: '5 Hartwold Lane', ...town, email: 'thessaly.grimsditch@example.org' }),
    gifts: [{ date: '-6y', amount: 25 }],
    phases: [
      { run: 'full', expect: { writes: 0, holds: held('before-horizon') } },
      { edit: { lgl: { gifts: [{ date: '-1d', amount: 20 }] } }, run: 'full', expect: { writes: 1, vg: { donor: true, lastGiftDate: '-1d' }, holds: [] } },
      { run: 'full', expect: { writes: 0, holds: [] } },
    ],
  },
  {
    name: 'couple-record-is-held-never-created',
    why: 'Unlinked donors, the first rule against duplicates: a name that holds two people is held; the import split these only with staff confirmation.',
    since: 4,
    link: false,
    ...lgl({ first: 'Hollis and Wren', last: 'Duxbury', street: '60 Fallowmere Road', ...town }),
    gifts: [GIFT],
    phases: [{ run: 'full', expect: { writes: 0, holds: held('couple-name') } }],
  },
  {
    name: 'deceased-unlinked-donor-is-held-never-created',
    why: 'Unlinked donors, Create: a donor deceased in LGL is never created in VG.',
    since: 4,
    link: false,
    lgl: { ...lglConstituent({ first: 'Ambrose', last: 'Kettlewell', street: '2 Mossborough Close', ...town }), is_deceased: true, deceased_date: '-30d' },
    gifts: [GIFT],
    phases: [{ run: 'full', expect: { writes: 0, holds: held('deceased-in-lgl') } }],
  },
  {
    name: 'look-alike-new-donors-first',
    why: 'Unlinked donors, the second rule against duplicates: two new donors who look like each other (same name, same ZIP, different emails) are both held, never both created. This is one of the pair.',
    since: 4,
    link: false,
    ...lgl({ first: 'Marisol', last: 'Tregarvon', street: '9 Wendlebury Row', ...town, email: 'marisol.t1@example.org' }),
    gifts: [GIFT],
    phases: [{ run: 'full', expect: { writes: 0, holds: held('duplicate-in-lgl') } }],
  },
  {
    name: 'look-alike-new-donors-second',
    why: 'The other half of look-alike-new-donors-first.',
    since: 4,
    link: false,
    ...lgl({ first: 'Marisol', last: 'Tregarvon', street: '31 Ashcombe Hollow', ...town, email: 'marisol.t2@example.org' }),
    gifts: [GIFT],
    phases: [{ run: 'full', expect: { writes: 0, holds: held('duplicate-in-lgl') } }],
  },
  {
    name: 'two-lgl-records-for-one-person-first',
    why: 'Unlinked donors, the second rule against duplicates: two unlinked donors that resolve to the same VG person (two LGL records for one person) are both held, and the person is not linked to either. This one owns the VG person.',
    since: 4,
    link: false,
    ...agreeing(twice),
    gifts: [GIFT],
    phases: [{ run: 'full', expect: { writes: 0, vg: { donor: false }, holds: held('duplicate-in-lgl') } }],
  },
  {
    name: 'two-lgl-records-for-one-person-second',
    why: 'The second LGL record of two-lgl-records-for-one-person-first.',
    since: 4,
    link: false,
    ...lgl(twice),
    gifts: [GIFT],
    phases: [{ run: 'full', expect: { writes: 0, holds: held('duplicate-in-lgl') } }],
  },
  {
    name: 'merge-loser-is-followed-to-the-survivor',
    why: 'Customer question 5, "follow a merge". The person is linked to this record; a second LGL record for the same person (merge-survivor) is held as already-linked-elsewhere. When this record disappears from LGL, the donor row is pointed at the survivor instead of removed. LGL\'s own merge is simulated by a delete: the API has no merge call, and whether a merge leaves anything the API can see is untested.',
    since: 4,
    ...agreeing(merged),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: [] } },
      { edit: { lgl: { delete: true } }, run: 'full', expect: { writes: 1, lgl: { deleted: true }, vg: { donorOf: 'merge-survivor-is-held-until-the-loser-goes' }, holds: [] } },
      { run: 'full', expect: { writes: 0, holds: [] } },
    ],
  },
  {
    name: 'merge-survivor-is-held-until-the-loser-goes',
    why: 'The surviving record of merge-loser-is-followed-to-the-survivor: held while the person is linked to the other record, then followed.',
    since: 4,
    link: false,
    ...lgl(merged),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: held('already-linked-elsewhere') } },
      { run: 'full', expect: { holds: [] } },
      { run: 'full', expect: { writes: 0, records: 8, holds: [] } },
    ],
  },
  {
    name: 'import-staff-skip-is-never-created',
    why: 'Staff decisions are not undone: a donor staff chose to Skip in the import review is loaded as a dismissed staff hold, and is never created, even after a new gift.',
    since: 4,
    link: false,
    importDecision: 'staff-skip',
    ...lgl({ first: 'Wilhelmina', last: 'Scarrowby', street: '11 Gildenford Road', ...town, email: 'wilhelmina.scarrowby@example.org' }),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: held('import-skip', 'dismissed') } },
      { edit: { lgl: { gifts: [{ date: '-1d', amount: 30 }] } }, run: 'full', expect: { writes: 0, holds: held('import-skip', 'dismissed') } },
    ],
  },
  {
    name: 'import-horizon-skip-stays-dismissed-until-a-new-gift',
    why: 'Staff decisions are not undone, a rule dismissal: a donor the import skipped for an old last gift is loaded as a dismissed rule hold with the fingerprint matching gives it, so the pass leaves it dismissed. A new gift changes the facts and the person is created.',
    since: 4,
    link: false,
    importDecision: 'horizon-skip',
    ...lgl({ first: 'Caspian', last: 'Dunwoodie', street: '23 Quillowbrae Hollow', ...town, email: 'caspian.dunwoodie@example.org' }),
    gifts: [{ date: '-7y', amount: 40 }],
    phases: [
      { run: 'full', expect: { writes: 0, holds: held('before-horizon', 'dismissed') } },
      { edit: { lgl: { gifts: [{ date: '-1d', amount: 20 }] } }, run: 'full', expect: { writes: 1, vg: { donor: true, lastGiftDate: '-1d' }, holds: [] } },
    ],
  },
  {
    name: 'import-hold-leaves-a-matching-donor-alone',
    why: 'An import hold (never decided by staff) is loaded open, and the sync leaves the donor alone while it is open, even though email and name match a VG person exactly.',
    since: 4,
    link: false,
    importDecision: 'hold',
    ...agreeing({ first: 'Ottoline', last: 'Brackwater', street: '6 Sedgecombe Lane', ...town, email: 'ottoline.brackwater@example.org' }),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, vg: { donor: false }, holds: held('import-hold') } },
      { run: 'full', expect: { writes: 0, vg: { donor: false }, holds: held('import-hold') } },
    ],
  },
]
