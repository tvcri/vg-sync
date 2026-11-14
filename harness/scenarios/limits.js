// Limits: the circuit breaker. Runs alone, so its low limit meets only its own people.
import { GIFT, address, vgPerson } from '../people.js'

const home = { street: '90 Kestrelmoor Lane', city: 'Warwick', state: 'RI', zip: '02886' }
const moved = { street: '11 Yarrowdene Street', city: 'Cranston', state: 'RI', zip: '02920' }
const coupleHolds = [{ field: 'firstName', reason: 'couple' }, { field: 'firstName', reason: 'couple' }]

export default [
  {
    name: 'circuit-breaker-trips-and-writes-nothing',
    why: 'Checks and the full pass, the circuit breaker: a plan that changes more people than the limit (--max-people 1; a couple\'s shared address change is two) fails the pass before any write, memory or hold. Without the limit the same pass goes through.',
    since: 3,
    runAlone: true,
    couple: true,
    vg: [vgPerson({ first: 'Jane', last: 'Doe', ...home }), vgPerson({ first: 'John', last: 'Doe', ...home })],
    lgl: {
      first_name: 'Jane and John', last_name: 'Doe',
      street_addresses: [{ street: home.street, city: home.city, state: home.state, postal_code: home.zip }],
    },
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: coupleHolds } },
      {
        edit: { lgl: { entries: { street_addresses: { street: moved.street, city: moved.city, state: moved.state, postal_code: moved.zip } } } },
        run: 'full',
        args: ['--max-people', '1'],
        expect: { passFails: true, vg: { address: address(home) }, holds: coupleHolds },
      },
      { run: 'full', expect: { writes: 2, vg: { address: address(moved) }, holds: coupleHolds } },
      { run: 'full', expect: { writes: 0, holds: coupleHolds } },
    ],
  },
]
