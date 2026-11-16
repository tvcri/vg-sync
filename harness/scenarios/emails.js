// Emails: a VG change is written to LGL (step 7); an LGL clear is held.
import { GIFT, agreeing } from '../people.js'

const base = { street: '8 Copperbeech Hollow', city: 'Warwick', state: 'RI', zip: '02886' }
const hollis = { first: 'Hollis', last: 'Merriweather', ...base, email: 'hollis.merriweather@example.org' }
const ingrid = { first: 'Ingrid', last: 'Sallowmere', ...base, email: 'ingrid.sallowmere@example.org' }

export default [
  {
    name: 'vg-email-change-after-agreement-reaches-lgl',
    why: 'The policy file: email vg-changed is to-lgl. Until step 7 this was vg-email-change-after-agreement-is-deferred (reported, nothing written); step 7 writes it: VG\'s email is added as LGL\'s preferred entry and the old one marked not current, and the next pass finds the two the same.',
    since: 7,
    ...agreeing(hollis),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: [] } },
      {
        edit: { vg: { email: 'hollis.m@example.org' } },
        run: 'full',
        expect: {
          writes: 0, lglWrites: 1, deferred: 0, vg: { email: 'hollis.m@example.org' }, lgl: { email: 'hollis.m@example.org' },
          lglEntries: { email_addresses: { current: 1, total: 2 } }, holds: [],
        },
      },
      { run: 'full', expect: { writes: 0, lglWrites: 0, deferred: 0, holds: [] } },
    ],
  },
  {
    name: 'lgl-email-cleared-after-agreement-holds-lgl-cleared',
    why: 'The policy file: clearing a value is held in both directions ("nothing in LGL is deleted" points that way). LGL\'s email marked not current leaves LGL with no email: lgl-cleared, VG unchanged.',
    since: 3,
    ...agreeing(ingrid),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: [] } },
      {
        edit: { lgl: { entries: { email_addresses: { not_current: true } } } },
        run: 'full',
        expect: { writes: 0, vg: { email: 'ingrid.sallowmere@example.org' }, lgl: { email: null }, holds: [{ field: 'email', reason: 'lgl-cleared' }] },
      },
      { run: 'full', expect: { writes: 0, holds: [{ field: 'email', reason: 'lgl-cleared' }] } },
    ],
  },
]
