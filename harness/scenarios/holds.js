// Holds: a refused write is not retried; a hold fixed by hand closes.
import { GIFT, agreeing } from '../people.js'

const base = { street: '52 Fernhallow Road', city: 'Warwick', state: 'RI', zip: '02886' }
// VG's PersonPatch caps suffix at 20 characters; LGL takes these.
const LONG_SUFFIX = 'Junior of Quillfeather Hollow'
const LONGER_SUFFIX = 'Junior of Quillfeather Commons'
const refused = [{ field: 'suffix', reason: 'vg-refused' }]
const dismissed = [{ field: 'suffix', reason: 'vg-refused', state: 'dismissed' }]

export default [
  {
    name: 'vg-refused-suffix-not-retried-quiet-when-dismissed-reopens-when-changed',
    why: 'Harness design step 3 ("A value VG refuses ... not retried on the next pass; dismissed, it stays quiet; changed, it reopens") and the sync design (a refused write is not retried while the values it saw are unchanged, whether the hold is open or dismissed). An LGL suffix longer than VG\'s 20 characters, changed after agreement, is refused (400). Finding for the engineer: the app\'s OpenAPI text for the dismissal endpoint says "a staff dismissal is permanent", which disagrees with both designs and with what the sync does here in phase 5.',
    since: 3,
    ...agreeing({ first: 'Augustin', last: 'Velloway', suffix: 'Jr', ...base }),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: [] } },
      { edit: { lgl: { suffix: LONG_SUFFIX } }, run: 'full', expect: { vg: { suffix: 'Jr' }, lgl: { suffix: LONG_SUFFIX }, holds: refused } },
      { run: 'full', expect: { writes: 0, vg: { suffix: 'Jr' }, holds: refused } },
      { edit: { dismiss: { field: 'suffix', reason: 'vg-refused', dismissalKind: 'staff' } }, run: 'full', expect: { writes: 0, vg: { suffix: 'Jr' }, holds: dismissed } },
      { edit: { lgl: { suffix: LONGER_SUFFIX } }, run: 'full', expect: { vg: { suffix: 'Jr' }, lgl: { suffix: LONGER_SUFFIX }, holds: refused } },
      { run: 'full', expect: { writes: 0, vg: { suffix: 'Jr' }, holds: refused } },
    ],
  },
  {
    name: 'held-first-name-fixed-in-vg-closes-hold-then-syncs',
    why: 'Harness design, step 3 set ("A held field fixed by hand on one side"): once staff make VG match, the field is first-match, the never-agreed hold closes, and the field syncs from then on (firstName lgl-changed is to-vg).',
    since: 3,
    ...agreeing({ first: 'Kathy', last: 'Ormsby', ...base }, { lgl: { first_name: 'Katherine' } }),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, vg: { firstName: 'Kathy' }, holds: [{ field: 'firstName', reason: 'never-agreed' }] } },
      { edit: { vg: { firstName: 'Katherine' } }, run: 'full', expect: { writes: 0, holds: [] } },
      { edit: { lgl: { first_name: 'Katharine' } }, run: 'full', expect: { writes: 1, vg: { firstName: 'Katharine' }, holds: [] } },
      { run: 'full', expect: { writes: 0, holds: [] } },
    ],
  },
]
