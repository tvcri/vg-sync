// The playground: a few invented people seeded by `npm run harness -- --seed-only`, for running
// the service by hand against the LGL trial account and the dev VG and making edits on either side.
// Scenario-shaped (so seedScenarios takes them) but with no phases: nothing is checked. Not under
// harness/scenarios/, so a harness run never plays them. Each starts with both sides agreeing,
// except the couple, whose LGL first name is the pair's.
import { GIFT, agreeing, vgPerson } from './people.js'

const playground = (name, why, spec) => ({ name, why, since: 7, phases: [], gifts: [GIFT], ...spec })

const cottage = { street: '41 Bramblecote Lane', city: 'Warwick', state: 'RI', zip: '02886' }

export const PLAYGROUND = [
  playground('playground-everything', 'One person with an address, an email, a home phone and a cell.', agreeing({
    first: 'Prudence', last: 'Ashgrove', street: '14 Larkspur Way', city: 'Cranston', state: 'RI', zip: '02920',
    email: 'prudence.ashgrove@example.org', phone: '401-555-0141', cell: '401-555-0142',
  })),
  playground('playground-email-only', 'An email and nothing else: adding an address or a phone on either side is a first value.', agreeing({
    first: 'Wendell', last: 'Pinecrest', email: 'wendell.pinecrest@example.org',
  })),
  playground('playground-nickname', 'A nickname on both sides.', agreeing({
    first: 'Robert', last: 'Thistledown', nick: 'Bob', street: '9 Hawthorn Rise', city: 'Providence', state: 'RI', zip: '02906',
    email: 'bob.thistledown@example.org', phone: '401-555-0191',
  })),
  {
    name: 'playground-couple',
    why: 'Two VG people on one LGL constituent ("Marisol and Ezra"): first names are couple holds; the address is shared.',
    since: 7,
    phases: [],
    gifts: [GIFT],
    couple: true,
    vg: [
      vgPerson({ first: 'Marisol', last: 'Quenby', ...cottage }),
      vgPerson({ first: 'Ezra', last: 'Quenby', ...cottage }),
    ],
    lgl: {
      first_name: 'Marisol and Ezra', last_name: 'Quenby',
      street_addresses: [{ street: cottage.street, city: cottage.city, state: cottage.state, postal_code: cottage.zip }],
    },
  },
]
