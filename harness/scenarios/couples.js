// Couples: two VG people linked to one LGL constituent.
import { GIFT, address, vgPerson } from '../people.js'

const home = { street: '63 Wrenfield Terrace', city: 'Warwick', state: 'RI', zip: '02886' }
const moved = { street: '18 Gorsemoor Drive', city: 'Cranston', state: 'RI', zip: '02920' }
const coupleHolds = [{ field: 'firstName', reason: 'couple' }, { field: 'firstName', reason: 'couple' }]

export default [
  {
    name: 'couple-first-names-held-and-shared-address-reaches-both',
    why: 'Couples: LGL\'s "Jane and John" never matches either partner, so each carries a couple hold on first name; customer question 7 (couple-lgl-changed is to-vg): a change to the shared LGL address reaches both partners.',
    since: 3,
    couple: true,
    vg: [vgPerson({ first: 'Jane', last: 'Doe', ...home }), vgPerson({ first: 'John', last: 'Doe', ...home })],
    lgl: {
      first_name: 'Jane and John', last_name: 'Doe',
      street_addresses: [{ street: home.street, city: home.city, state: home.state, postal_code: home.zip }],
    },
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, vg: [{ firstName: 'Jane' }, { firstName: 'John' }], holds: coupleHolds } },
      {
        edit: { lgl: { entries: { street_addresses: { street: moved.street, city: moved.city, state: moved.state, postal_code: moved.zip } } } },
        run: 'full',
        expect: { writes: 2, vg: { address: address(moved) }, holds: coupleHolds },
      },
      { run: 'full', expect: { writes: 0, holds: coupleHolds } },
    ],
  },
]
