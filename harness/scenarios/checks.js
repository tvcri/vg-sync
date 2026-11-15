// Change checks (step 6): a phase runs one check by hand (--once lgl-check or vg-check) in place of a
// full pass. Each check reads the cursor its scenario's own earlier full pass set, so every scenario here
// runs alone (the last two as one group of two pairs). Invented people in a town that does not exist.
import { GIFT, agreeing } from '../people.js'

const town = { city: 'Zzyzxford', state: 'RI', zip: '00901' }
const held = [{ field: 'firstName', reason: 'never-agreed' }]

const renamed = { first: 'Florentin', last: 'Quellbury', street: '14 Brackenhurst Lane', ...town, email: 'florentin.quellbury@example.org' }
const giving = { first: 'Hesper', last: 'Mallowfield', street: '22 Thistlecombe Road', ...town, email: 'hesper.mallowfield@example.org' }
const firstGift = { first: 'Corisande', last: 'Wraybrook', street: '5 Lanternmere Court', ...town, email: 'corisande.wraybrook@example.org' }
const vgEdit = { first: 'Ptolemy', last: 'Ashwinder', street: '31 Gallowmere Row', ...town, email: 'ptolemy.ashwinder@example.org' }
const holdPair = { first: 'Tamsin', last: 'Corrowdale', street: '9 Fennimore Hollow', ...town, email: 'tamsin.corrowdale@example.org' }
const otherPair = { first: 'Leocadia', last: 'Pellingham', street: '17 Rookswold Lane', ...town, email: 'leocadia.pellingham@example.org' }

export default [
  {
    name: 'lgl-name-edit-reaches-vg-by-lgl-check',
    why: 'Step 6, the LGL check: a first name edited in LGL after agreement (lgl-changed, to-vg) reaches VG on the next LGL check, without a full pass.',
    since: 6,
    runAlone: true,
    ...agreeing(renamed),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: [] } },
      { edit: { lgl: { first_name: 'Florian' } }, run: 'lgl-check', expect: { writes: 1, vg: { firstName: 'Florian' }, holds: [] } },
    ],
  },
  {
    name: 'new-gift-moves-last-gift-date-by-lgl-check',
    why: 'Step 6, the LGL check: a new gift on a linked donor moves VG\'s last gift date on the next LGL check.',
    since: 6,
    runAlone: true,
    ...agreeing(giving),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, vg: { lastGiftDate: GIFT.date }, holds: [] } },
      { edit: { lgl: { gifts: [{ date: '-2d', amount: 25 }] } }, run: 'lgl-check', expect: { writes: 1, vg: { lastGiftDate: '-2d' }, holds: [] } },
    ],
  },
  {
    name: 'first-gift-links-matching-person-by-lgl-check',
    why: 'Step 6, the LGL check: a constituent with no gift is no donor, so the full pass links nothing. After a first gift, the LGL check matches the VG person with the same name and email and links them (Unlinked donors, Link).',
    since: 6,
    runAlone: true,
    link: false,
    ...agreeing(firstGift),
    phases: [
      { run: 'full', expect: { writes: 0, vg: { donor: false }, holds: [] } },
      { edit: { lgl: { gifts: [{ date: '-1d', amount: 20 }] } }, run: 'lgl-check', expect: { writes: 1, vg: { donor: true, lastGiftDate: '-1d' }, holds: [] } },
    ],
  },
  {
    name: 'vg-edit-is-deferred-by-vg-check',
    why: 'Step 6, the VG check: an email edited in VG after agreement (vg-changed) is planned to-lgl and recorded deferred. Nothing is written to either side until step 7.',
    since: 6,
    runAlone: true,
    ...agreeing(vgEdit),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: [] } },
      {
        edit: { vg: { email: 'p.ashwinder@example.org' } },
        run: 'vg-check',
        expect: { deferred: 1, writes: 0, vg: { email: 'p.ashwinder@example.org' }, lgl: { email: vgEdit.email }, holds: [] },
      },
    ],
  },
  {
    name: 'check-leaves-untouched-hold-open',
    why: 'Step 6, holds in a check: a check passes on only the holds of the constituents it touched, so an open hold on a pair it did not touch stays open. The hold is a never-agreed first name from the seed (policy.json plans both-changed to-lgl, which is deferred in step 6, not held). Runs with check-leaves-untouched-hold-open-edited, whose LGL edit is what the check finds.',
    since: 6,
    runAlone: 'check-leaves-untouched-hold-open',
    ...agreeing(holdPair, { lgl: { first_name: 'Tamsyn' } }),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, vg: { firstName: 'Tamsin' }, holds: held } },
      { run: 'lgl-check', expect: { writes: 0, vg: { firstName: 'Tamsin' }, holds: held } },
    ],
  },
  {
    name: 'check-leaves-untouched-hold-open-edited',
    why: 'The other pair of check-leaves-untouched-hold-open: its LGL edit gives the LGL check a change to apply while the held pair sits untouched.',
    since: 6,
    runAlone: 'check-leaves-untouched-hold-open',
    ...agreeing(otherPair),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: [] } },
      { edit: { lgl: { first_name: 'Leocadie' } }, run: 'lgl-check', expect: { writes: 1, vg: { firstName: 'Leocadie' }, holds: [] } },
    ],
  },
]
