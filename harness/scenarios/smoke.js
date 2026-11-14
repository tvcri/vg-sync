// The smoke scenario: proves the runner end to end. Invented person and an invented
// street (a plausible real one, 12 Elm Street, was rewritten by LGL's verification).
export default [
  {
    name: 'smoke',
    why: 'Everything agrees: the first pass records memory and writes nothing, and so does the second.',
    since: 3,
    vg: {
      firstName: 'Jane', lastName: 'Doe',
      street: '17 Thimblewick Lane', city: 'Warwick', state: 'RI', zip: '02886',
      email: 'jane.doe@example.org', phone: '401-555-0101',
    },
    lgl: {
      first_name: 'Jane', last_name: 'Doe',
      street_addresses: [{ street: '17 Thimblewick Lane', city: 'Warwick', state: 'RI', postal_code: '02886' }],
      email_addresses: [{ address: 'jane.doe@example.org' }],
      phone_numbers: [{ number: '401-555-0101', type: 'Home' }],
    },
    gifts: [{ date: '-60d', amount: 50 }],
    phases: [
      { run: 'full', expect: { writes: 0, holds: [] } },
      { run: 'full', expect: { writes: 0, holds: [] } },
    ],
  },
]
