// Emails: a VG change waits for LGL writes (step 7); an LGL clear is held.
import { GIFT, agreeing } from '../people.js'

const base = { street: '8 Copperbeech Hollow', city: 'Warwick', state: 'RI', zip: '02886' }
const hollis = { first: 'Hollis', last: 'Merriweather', ...base, email: 'hollis.merriweather@example.org' }
const ingrid = { first: 'Ingrid', last: 'Sallowmere', ...base, email: 'ingrid.sallowmere@example.org' }

export default [
  {
    name: 'vg-email-change-after-agreement-is-deferred',
    why: 'The policy file: email vg-changed is to-lgl, and to-lgl is deferred until LGL writes exist: reported, nothing written. Step 7 changes `since` and this expectation to the LGL write.',
    since: 3,
    ...agreeing(hollis),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: [] } },
      {
        edit: { vg: { email: 'hollis.m@example.org' } },
        run: 'full',
        expect: { writes: 0, deferred: 1, vg: { email: 'hollis.m@example.org' }, lgl: { email: 'hollis.merriweather@example.org' }, holds: [] },
      },
      { run: 'full', expect: { writes: 0, deferred: 1, holds: [] } },
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
