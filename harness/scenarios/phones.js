// Phones: compared as a set of numbers; a number only LGL has fills an empty VG slot.
import { GIFT, agreeing } from '../people.js'

const base = { street: '22 Lanternwick Row', city: 'Warwick', state: 'RI', zip: '02886' }
const priya = { first: 'Priya', last: 'Vantongeren', ...base, cell: '401-555-0201' }
const corwin = { first: 'Corwin', last: 'Haskeldt', ...base, phone: '401-555-0211', cell: '401-555-0212' }
const delphine = { first: 'Delphine', last: 'Okonkwo-Reyes', ...base, phone: '401-555-0221' }

export default [
  {
    name: 'lgl-only-phone-fills-empty-vg-slot',
    why: 'Customer question 3: a number only LGL has is copied to VG (phones never-agreed is merge). VG\'s own cell stays; its LGL half is deferred until step 7.',
    since: 3,
    ...agreeing(priya, { lgl: { phone_numbers: [{ number: '401-555-0202', type: 'Home' }] } }),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 1, deferred: 1, vg: { phones: { phone: '401-555-0202', cell: '401-555-0201' } }, holds: [] } },
      { run: 'full', expect: { writes: 0, vg: { phones: { phone: '401-555-0202', cell: '401-555-0201' } }, holds: [] } },
    ],
  },
  {
    name: 'lgl-only-phone-with-no-empty-slot-holds-phones-no-slot',
    why: 'Customer question 3 and the merge rule: a number only LGL has, with both VG slots full, cannot be placed; it is held phones-no-slot and VG keeps its numbers.',
    since: 3,
    ...agreeing(corwin, { lgl: { phone_numbers: [{ number: '401-555-0213', type: 'Home' }] } }),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, vg: { phones: { phone: '401-555-0211', cell: '401-555-0212' } }, holds: [{ field: 'phones', reason: 'phones-no-slot' }] } },
      { run: 'full', expect: { writes: 0, holds: [{ field: 'phones', reason: 'phones-no-slot' }] } },
    ],
  },
  {
    name: 'lgl-phone-change-after-agreement-reaches-vg',
    why: 'The policy file: phones lgl-changed is to-vg (the customer\'s "two-way").',
    since: 3,
    ...agreeing(delphine),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: [] } },
      {
        edit: { lgl: { entries: { phone_numbers: { number: '401-555-0222' } } } },
        run: 'full',
        expect: { writes: 1, vg: { phones: { phone: '401-555-0222', cell: null } }, holds: [] },
      },
      { run: 'full', expect: { writes: 0, holds: [] } },
    ],
  },
]
