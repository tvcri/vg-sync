// Names: held when they differ at the first pass, copied to VG once agreed.
// Invented people only.
import { GIFT, agreeing } from '../people.js'

const rowena = { first: 'Rowena', last: 'Thistlewood', nick: 'Ro', suffix: 'Jr', street: '14 Quillfeather Lane', city: 'Warwick', state: 'RI', zip: '02886' }
const tobias = { first: 'Tobias', last: 'Ashgrove', street: '9 Tallowick Street', city: 'Cranston', state: 'RI', zip: '02920' }

export default [
  {
    name: 'names-differing-at-first-pass-are-held-never-agreed',
    why: 'The policy file: names in never-agreed are hold (customer question 2, "names and nicknames held and listed"). First name, last name, nickname and suffix each get a never-agreed hold, and neither side is changed.',
    since: 3,
    ...agreeing(rowena, { lgl: { first_name: 'Rowan', last_name: 'Thistlewaite', nick_name: 'Wren', suffix: 'Sr' } }),
    gifts: [GIFT],
    phases: [
      {
        run: 'full',
        expect: {
          writes: 0,
          vg: { firstName: 'Rowena', lastName: 'Thistlewood', nickname: 'Ro', suffix: 'Jr' },
          lgl: { firstName: 'Rowan', lastName: 'Thistlewaite', nickname: 'Wren', suffix: 'Sr' },
          holds: [
            { field: 'firstName', reason: 'never-agreed' },
            { field: 'lastName', reason: 'never-agreed' },
            { field: 'nickname', reason: 'never-agreed' },
            { field: 'suffix', reason: 'never-agreed' },
          ],
        },
      },
      {
        run: 'full',
        expect: {
          writes: 0,
          vg: { firstName: 'Rowena', lastName: 'Thistlewood', nickname: 'Ro', suffix: 'Jr' },
          holds: [
            { field: 'firstName', reason: 'never-agreed' },
            { field: 'lastName', reason: 'never-agreed' },
            { field: 'nickname', reason: 'never-agreed' },
            { field: 'suffix', reason: 'never-agreed' },
          ],
        },
      },
    ],
  },
  {
    name: 'lgl-last-name-change-after-agreement-reaches-vg',
    why: 'The policy file: lastName lgl-changed is to-vg (the customer\'s "two-way": an edit made in LGL reaches VG).',
    since: 3,
    ...agreeing(tobias),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: [] } },
      {
        edit: { lgl: { last_name: 'Ashgrove-Penhallow' } },
        run: 'full',
        expect: { writes: 1, vg: { lastName: 'Ashgrove-Penhallow', firstName: 'Tobias' }, holds: [] },
      },
      { run: 'full', expect: { writes: 0, holds: [] } },
    ],
  },
]
