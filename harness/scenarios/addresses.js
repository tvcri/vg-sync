// Addresses: an LGL change after agreement reaches VG; an unclean LGL address is never copied, and VG's
// address replaces it in LGL (step 7).
// Invented streets, so LGL's verification sweep stamps them and rewrites nothing.
import { GIFT, address, agreeing } from '../people.js'

const marisol = { first: 'Marisol', last: 'Fenwhistle', street: '31 Marrowbend Road', city: 'Warwick', state: 'RI', zip: '02886', phone: '401-555-0141' }
const moved = { street: '77 Brindlecomb Way', city: 'Cranston', state: 'RI', zip: '02920' }
const ottilie = { first: 'Ottilie', last: 'Pellinore', street: '6 Cindertop Court', city: 'Zzyzxford', state: 'RI', zip: '00901' }
const osgood = { first: 'Osgood', last: 'Pellinore', street: '5 Cindertop Court', city: 'Warwick', state: 'RI', zip: '02888' }

export default [
  {
    name: 'lgl-address-change-after-agreement-reaches-vg',
    why: 'The policy file: address lgl-changed is to-vg; Fields: an address moves whole, with its town looked up.',
    since: 3,
    ...agreeing(marisol),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: [] } },
      {
        edit: { lgl: { entries: { street_addresses: { street: moved.street, city: moved.city, state: moved.state, postal_code: moved.zip } } } },
        run: 'full',
        expect: { writes: 1, vg: { address: address(moved) }, holds: [] },
      },
      { run: 'full', expect: { writes: 0, holds: [] } },
    ],
  },
  {
    name: 'unclean-lgl-city-after-agreement-is-held-unclean-reopens-on-new-malformed-value',
    why: 'The policy file, Guards (Unclean): an LGL value that fails cleaning (here a city with a digit) is never copied to VG. After agreement, LGL\'s change is lgl-changed, whose action is to-vg, so the guard holds it unclean and VG keeps its address. Dismissed, it stays quiet; the engineer\'s ruling on finding (b), 2026-11-14: a change to a different malformed value reopens it.',
    since: 3,
    ...agreeing(osgood),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: [] } },
      {
        edit: { lgl: { entries: { street_addresses: { street: osgood.street, city: 'Warwick 2', state: 'RI', postal_code: osgood.zip } } } },
        run: 'full',
        expect: { writes: 0, vg: { address: address(osgood) }, holds: [{ field: 'address', reason: 'unclean' }] },
      },
      { run: 'full', expect: { writes: 0, vg: { address: address(osgood) }, holds: [{ field: 'address', reason: 'unclean' }] } },
      { edit: { dismiss: { field: 'address', reason: 'unclean', dismissalKind: 'staff' } }, run: 'full', expect: { writes: 0, holds: [{ field: 'address', reason: 'unclean', state: 'dismissed' }] } },
      {
        edit: { lgl: { entries: { street_addresses: { street: osgood.street, city: 'Warwick 9', state: 'RI', postal_code: osgood.zip } } } },
        run: 'full',
        expect: { writes: 0, vg: { address: address(osgood) }, holds: [{ field: 'address', reason: 'unclean' }] },
      },
    ],
  },
  {
    name: 'unclean-lgl-city-never-agreed-goes-to-lgl',
    why: 'The policy file, Guards (Unclean): the guard blocks to-vg only, and a copy from VG that would repair LGL goes ahead. A never-agreed address is to-lgl (customer question 2). Until step 7 it was deferred (no hold, no write); step 7 writes VG\'s address as LGL\'s preferred entry and marks the unclean entry it read not current. In the invented town Zzyzxford since step 7, so LGL\'s verification sweep leaves the written address alone.',
    since: 7,
    ...agreeing(ottilie, { lgl: { street_addresses: [{ street: ottilie.street, city: 'Zzyzxford 3', state: 'RI', postal_code: ottilie.zip }] } }),
    gifts: [GIFT],
    phases: [
      {
        run: 'full',
        expect: {
          writes: 0, lglWrites: 1, deferred: 0, vg: { address: address(ottilie) }, lgl: { address: address(ottilie) },
          lglEntries: { street_addresses: { current: 1, total: 2 } }, holds: [],
        },
      },
      { run: 'full', expect: { writes: 0, lglWrites: 0, deferred: 0, vg: { address: address(ottilie) }, holds: [] } },
    ],
  },
]
