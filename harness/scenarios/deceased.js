// Deceased: the mark goes toward the side marked deceased, with its date, and is never removed by the service.
import { GIFT, agreeing } from '../people.js'

const wendell = { first: 'Wendell', last: 'Brackenridge', street: '40 Mossgate Lane', city: 'Warwick', state: 'RI', zip: '02886' }
const DIED = '-90d'

export default [
  {
    name: 'lgl-deceased-mark-reaches-vg-and-its-removal-is-held',
    why: 'Customer question 4 (the policy file, deceased never-agreed is toward-deceased): a mark only LGL has reaches VG with its date. The deceased-removed guard: LGL removing the mark after agreement is held, and VG keeps it.',
    since: 3,
    ...agreeing(wendell, { lgl: { is_deceased: true, deceased_date: DIED } }),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 1, vg: { deceased: { flag: true, date: DIED } }, holds: [] } },
      {
        edit: { lgl: { is_deceased: false, deceased_date: null } },
        run: 'full',
        expect: { writes: 0, vg: { deceased: { flag: true, date: DIED } }, lgl: { deceased: { flag: false, date: null } }, holds: [{ field: 'deceased', reason: 'deceased-removed' }] },
      },
      { run: 'full', expect: { writes: 0, vg: { deceased: { flag: true, date: DIED } }, holds: [{ field: 'deceased', reason: 'deceased-removed' }] } },
    ],
  },
]
