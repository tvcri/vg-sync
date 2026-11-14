// Records: a pair that agrees, and a constituent deleted in LGL.
import { GIFT, agreeing } from '../people.js'

const base = { street: '3 Bramblecote Close', city: 'Warwick', state: 'RI', zip: '02886' }

export default [
  {
    name: 'everything-agrees-records-memory-and-writes-nothing',
    why: 'Comparing a field: a pair seen for the first time whose fields match is first-match, recorded as agreed (one record per field); nothing is written and no hold opens. On the next pass every field is same: nothing recorded, written or held.',
    since: 3,
    ...agreeing({ first: 'Jane', last: 'Doe', ...base, email: 'jane.doe.agrees@example.org', phone: '401-555-0301', cell: '401-555-0302', nick: 'Janie' }),
    gifts: [GIFT],
    phases: [
      // One agree record per field, all eight: a field empty on both sides (suffix) is agreed as empty too.
      { run: 'full', expect: { writes: 0, deferred: 0, records: 8, holds: [] } },
      { run: 'full', expect: { writes: 0, deferred: 0, records: 0, holds: [] } },
    ],
  },
  {
    name: 'deleted-lgl-constituent-unlink-is-deferred',
    why: 'The policy file: lgl-missing is unlink (customer question 5), and unlink is deferred until step 4: reported and counted, no write, no hold; the person keeps the Donor mark for now.',
    since: 3,
    ...agreeing({ first: 'Simeon', last: 'Halloran-Pryce', ...base }),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: [] } },
      { edit: { lgl: { delete: true } }, run: 'full', expect: { writes: 0, deferred: 1, lgl: { deleted: true }, vg: { donor: true }, holds: [] } },
      { run: 'full', expect: { writes: 0, deferred: 1, vg: { donor: true }, holds: [] } },
    ],
  },
  {
    name: 'deleted-lgl-constituent-loses-donor-mark',
    why: 'Customer question 5 (lgl-missing is unlink): the person stays in VG without the Donor mark. Needs step 4\'s unlink.',
    since: 4,
    ...agreeing({ first: 'Thaddeus', last: 'Corrigall', ...base }),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: [] } },
      { edit: { lgl: { delete: true } }, run: 'full', expect: { lgl: { deleted: true }, vg: { donor: false } } },
      { run: 'full', expect: { writes: 0, vg: { donor: false } } },
    ],
  },
]
