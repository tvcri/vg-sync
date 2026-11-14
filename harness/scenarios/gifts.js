// Gifts: the last gift date VG shows is computed from LGL's counting gifts; dues do not count.
import { GIFT, agreeing } from '../people.js'

const base = { street: '27 Hartsease Lane', city: 'Warwick', state: 'RI', zip: '02886' }
const DUES = { amount: 40, dues: true }
const OLD_DATE = '-400d' // a date VG already shows, from a gift LGL no longer counts

export default [
  {
    name: 'newer-lgl-gift-date-reaches-vg',
    why: 'Fields, last gift date: computed from LGL\'s gifts and written to VG\'s donor row whenever it differs.',
    since: 3,
    ...agreeing({ first: 'Lucinda', last: 'Garrowby', ...base }),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, vg: { lastGiftDate: GIFT.date }, holds: [] } },
      { edit: { lgl: { gifts: [{ date: '-5d', amount: 25 }] } }, run: 'full', expect: { writes: 1, vg: { lastGiftDate: '-5d' }, holds: [] } },
      { run: 'full', expect: { writes: 0, vg: { lastGiftDate: '-5d' }, holds: [] } },
    ],
  },
  {
    name: 'dues-gift-does-not-move-last-gift-date',
    why: 'Fields, last gift date: the latest counting gift that is not dues (membership fund paid by PayPal; the trial account\'s stand-ins). A newer dues gift, seeded or added later, changes nothing.',
    since: 3,
    ...agreeing({ first: 'Benedikt', last: 'Arlingham', ...base }),
    gifts: [GIFT, { date: '-10d', ...DUES }],
    phases: [
      { run: 'full', expect: { writes: 0, vg: { lastGiftDate: GIFT.date }, holds: [] } },
      { edit: { lgl: { gifts: [{ date: '-3d', ...DUES }] } }, run: 'full', expect: { writes: 0, vg: { lastGiftDate: GIFT.date }, holds: [] } },
      { run: 'full', expect: { writes: 0, vg: { lastGiftDate: GIFT.date }, holds: [] } },
    ],
  },
  {
    name: 'dues-only-constituent-holds-no-longer-donor',
    why: 'The policy file: no-longer-donor is hold (not asked of the customer). A linked constituent whose only gift is dues fails the donor rule. Fields, last gift date: a null LGL last gift date never clears VG\'s, so VG\'s older date (set on the donor row before the first pass) stays, with no date write.',
    since: 3,
    ...agreeing({ first: 'Philippa', last: 'Quenby', ...base }),
    gifts: [{ date: '-30d', ...DUES }],
    phases: [
      {
        edit: { vg: { lastGiftDate: OLD_DATE } },
        run: 'full',
        expect: { writes: 0, vg: { donor: true, lastGiftDate: OLD_DATE }, holds: [{ field: null, reason: 'no-longer-donor' }] },
      },
      { run: 'full', expect: { writes: 0, vg: { donor: true, lastGiftDate: OLD_DATE }, holds: [{ field: null, reason: 'no-longer-donor' }] } },
    ],
  },
]
