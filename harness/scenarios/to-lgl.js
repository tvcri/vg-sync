// Writes to LGL (step 7): VG's value becomes LGL's, an entry replaced is marked not current, and the
// guards hold what must not be written. Invented people in a town that does not exist (Zzyzxford,
// ZIP 00901), so LGL's verification sweep leaves the addresses written here alone.
import { GIFT, address, agreeing, vgPerson } from '../people.js'

const town = { city: 'Zzyzxford', state: 'RI', zip: '00901' }
const lglAddr = (street) => ({ street, city: town.city, state: town.state, postal_code: town.zip })
const settled = (extra = {}) => ({ run: 'full', expect: { writes: 0, lglWrites: 0, deferred: 0, ...extra } })

const bothChanged = { first: 'Wilhelmina', last: 'Quarrendon', street: '3 Hollyhock Rise', ...town, email: 'wilhelmina.quarrendon@example.org' }
const neverAgreed = { first: 'Barnaby', last: 'Esterhollow', street: '19 Harrowgate Lane', ...town }
const revived = { first: 'Clemency', last: 'Ravensworth', street: '27 Merrowdown Close', ...town }
const formerHome = '8 Saltmarsh Walk'
const poBox = { first: 'Ignatius', last: 'Fallowfield', street: '41 Pennyroyal Street', ...town }
const deceased = { first: 'Henrietta', last: 'Coldharbour', street: '12 Wychwood Bend', ...town }
const DIED = '-30d'
const rebuilt = { first: 'Peregrine', last: 'Southwold', street: '6 Larkspur Gardens', ...town }
const handWritten = { first: 'Rosalind', last: 'Quenby', street: '15 Cobblestone Yard', ...town }
const coupleHome = { street: '50 Thornbury Crescent', ...town }
const coupleMoved = { street: '2 Bellweather Court', ...town }
const pairHome = { street: '33 Juniper Hollow', ...town }
const pairMoved = { street: '9 Starling Mews', ...town }
const malformed = { first: 'Leontyne', last: 'Marchbank', street: '20 Quillon Way', ...town, email: 'leontyne.marchbank@example.org' }
const phones = { first: 'Ottoline', last: 'Grisedale', street: '44 Kingcup Lane', ...town, phone: '401-555-0151', cell: '401-555-0152' }
const work = { first: 'Fitzroy', last: 'Abernethy', street: '7 Mallowmere Road', ...town, phone: '401-555-0161' }
const ownWrite = { first: 'Sabine', last: 'Thackeray', street: '18 Dovecote Row', ...town, email: 'sabine.thackeray@example.org' }
const stale = { first: 'Evander', last: 'Pilkington', street: '25 Nettlebed Lane', ...town, email: 'evander.pilkington@example.org' }
const flapping = { first: 'Gwendolen', last: 'Ashcombe', street: '11 Tumbledown Hill', ...town, email: 'gwendolen.ashcombe@example.org' }
const notAllowed = { first: 'Cornelius', last: 'Bramblecote', street: '36 Hazelwick Drive', ...town, email: 'cornelius.bramblecote@example.org' }

const lglCouple = (first, last, home) => ({ first_name: first, last_name: last, street_addresses: [lglAddr(home.street)] })
const coupleHolds = [{ field: 'firstName', reason: 'couple' }, { field: 'firstName', reason: 'couple' }]

export default [
  {
    name: 'both-changed-vg-wins-old-lgl-value-logged',
    why: 'Step 7, the policy file: email both-changed is to-lgl (VG wins). VG\'s email is added as LGL\'s preferred entry and the entry LGL had is marked not current; the write log keeps LGL\'s old value.',
    since: 7,
    ...agreeing(bothChanged),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: [] } },
      {
        edit: { vg: { email: 'w.quarrendon@example.org' }, lgl: { entries: { email_addresses: { address: 'wilhelmina.q@example.org' } } } },
        run: 'full',
        expect: {
          writes: 0, lglWrites: 1, deferred: 0, vg: { email: 'w.quarrendon@example.org' }, lgl: { email: 'w.quarrendon@example.org' },
          lglEntries: { email_addresses: { current: 1, total: 2 } }, lglLog: { email: 'wilhelmina.q@example.org' }, holds: [],
        },
      },
      settled({ holds: [] }),
    ],
  },
  {
    name: 'never-agreed-address-replaced-old-entry-not-current',
    why: 'Step 7, customer question 2: a never-agreed address is to-lgl. VG\'s address is added as LGL\'s preferred entry and LGL\'s own is marked not current, not deleted.',
    since: 7,
    ...agreeing(neverAgreed, { lgl: { street_addresses: [lglAddr('4 Old Tannery Road')] } }),
    gifts: [GIFT],
    phases: [
      {
        run: 'full',
        expect: { writes: 0, lglWrites: 1, deferred: 0, lgl: { address: address(neverAgreed) }, lglEntries: { street_addresses: { current: 1, total: 2 } }, holds: [] },
      },
      settled({ vg: { address: address(neverAgreed) }, holds: [] }),
    ],
  },
  {
    name: 'vg-address-on-file-not-current-is-revived',
    why: 'Step 7, the call builder: VG\'s new address is already on file in LGL as a not-current entry, so that entry is made current and preferred again rather than added twice; the entry the sync read is marked not current. Phase 1 shows the seed stored the old one as not current.',
    since: 7,
    ...agreeing(revived, { lgl: { street_addresses: [{ ...lglAddr(revived.street), is_preferred: true }, { ...lglAddr(formerHome), not_current: true }] } }),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, lglWrites: 0, lglEntries: { street_addresses: { current: 1, total: 2 } }, holds: [] } },
      {
        edit: { vg: { street: formerHome } },
        run: 'full',
        expect: {
          writes: 0, lglWrites: 1, deferred: 0, lgl: { address: address({ ...revived, street: formerHome }) },
          lglEntries: { street_addresses: { current: 1, total: 2 } }, holds: [],
        },
      },
      settled({ holds: [] }),
    ],
  },
  {
    name: 'po-box-in-lgl-is-held',
    why: 'Step 7, Guards (PO box): a write to LGL that would replace a PO box is held po-box, and LGL keeps its address. A never-agreed address is otherwise to-lgl.',
    since: 7,
    ...agreeing(poBox, { lgl: { street_addresses: [lglAddr('PO Box 412')] } }),
    gifts: [GIFT],
    phases: [
      {
        run: 'full',
        expect: { writes: 0, lglWrites: 0, deferred: 0, lgl: { address: address({ ...poBox, street: 'PO Box 412' }) }, holds: [{ field: 'address', reason: 'po-box' }] },
      },
      { run: 'full', expect: { writes: 0, lglWrites: 0, lglEntries: { street_addresses: { current: 1, total: 1 } }, holds: [{ field: 'address', reason: 'po-box' }] } },
    ],
  },
  {
    name: 'deceased-in-vg-is-marked-in-lgl-with-date',
    why: 'Step 7, customer question 4 (deceased never-agreed is toward-deceased): a mark only VG has goes to LGL with its date.',
    since: 7,
    ...agreeing(deceased, { vg: { deceased: true, deceasedDate: DIED } }),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, lglWrites: 1, deferred: 0, lgl: { deceased: { flag: true, date: DIED } }, holds: [] } },
      settled({ vg: { deceased: { flag: true, date: DIED } }, holds: [] }),
    ],
  },
  {
    name: 'name-change-rebuilds-default-addressee',
    why: 'Step 7, the addressee rule (lgl-addressee if-default): a last name written to LGL while the addressee and salutation are LGL\'s defaults sends them empty, and LGL builds them again from the new name.',
    since: 7,
    ...agreeing(rebuilt),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, lgl: { addressee: 'Peregrine Southwold', salutation: 'Peregrine' }, holds: [] } },
      {
        edit: { vg: { lastName: 'Southwold-Ainsley' } },
        run: 'full',
        expect: {
          writes: 0, lglWrites: 1, deferred: 0, lgl: { lastName: 'Southwold-Ainsley', addressee: 'Peregrine Southwold-Ainsley', salutation: 'Peregrine' }, holds: [],
        },
      },
      settled({ holds: [] }),
    ],
  },
  {
    name: 'name-change-leaves-hand-written-addressee-and-holds',
    why: 'Step 7, the addressee rule: a last name written to LGL leaves a hand-written addressee and salutation as they are, and opens an addressee hold for staff. The sync never closes it (not owned): it stays open on the next pass.',
    since: 7,
    ...agreeing(handWritten, { lgl: { addressee: 'The Quenby Household', salutation: 'Friends' } }),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, lgl: { addressee: 'The Quenby Household', salutation: 'Friends' }, holds: [] } },
      {
        edit: { vg: { lastName: 'Quenby-Hart' } },
        run: 'full',
        expect: {
          writes: 0, lglWrites: 1, deferred: 0, lgl: { lastName: 'Quenby-Hart', addressee: 'The Quenby Household', salutation: 'Friends' },
          holds: [{ field: 'lastName', reason: 'addressee' }],
        },
      },
      settled({ holds: [{ field: 'lastName', reason: 'addressee' }] }),
    ],
  },
  {
    name: 'couple-both-changed-same-writes-once',
    why: 'Step 7, couples: when both partners changed a shared field in VG to the same value, it is written to LGL once. The decisions file has one write-lgl row per partner (lglWrites 2); LGL holds one new entry and one retired (once, not twice).',
    since: 7,
    couple: true,
    vg: [vgPerson({ first: 'Ambrose', last: 'Wetherell', ...coupleHome }), vgPerson({ first: 'Philippa', last: 'Wetherell', ...coupleHome })],
    lgl: lglCouple('Ambrose and Philippa', 'Wetherell', coupleHome),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: coupleHolds } },
      {
        edit: { vg: [{ street: coupleMoved.street }, { person: 1, street: coupleMoved.street }] },
        run: 'full',
        expect: {
          writes: 0, lglWrites: 2, deferred: 0, vg: { address: address(coupleMoved) }, lgl: { address: address(coupleMoved) },
          lglEntries: { street_addresses: { current: 1, total: 2 } }, holds: coupleHolds,
        },
      },
      settled({ holds: coupleHolds }),
    ],
  },
  {
    name: 'couple-one-changed-is-held',
    why: 'Step 7, couples: a shared field one partner changed in VG and the other did not is not written to LGL; the partner who changed it is held couple, and LGL keeps its address.',
    since: 7,
    couple: true,
    vg: [vgPerson({ first: 'Lysander', last: 'Mottram', ...pairHome }), vgPerson({ first: 'Imogen', last: 'Mottram', ...pairHome })],
    lgl: lglCouple('Lysander and Imogen', 'Mottram', pairHome),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: coupleHolds } },
      {
        edit: { vg: { street: pairMoved.street } },
        run: 'full',
        expect: {
          writes: 0, lglWrites: 0, deferred: 0, vg: [{ address: address(pairMoved) }, { address: address(pairHome) }], lgl: { address: address(pairHome) },
          holds: [...coupleHolds, { field: 'address', reason: 'couple' }],
        },
      },
      { run: 'full', expect: { writes: 0, lglWrites: 0, holds: [...coupleHolds, { field: 'address', reason: 'couple' }] } },
    ],
  },
  {
    name: 'malformed-email-stored-not-current-is-held-old-kept',
    why: 'Step 7, refusals: LGL answers a malformed email (a space inside) with 200 but stores it not current. The write is refused: an lgl-refused hold, and LGL\'s old email stays current (the retire is never sent). The next pass does not try it again.',
    since: 7,
    ...agreeing(malformed),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: [] } },
      {
        edit: { vg: { email: 'leontyne marchbank@example.org' } },
        run: 'full',
        expect: {
          writes: 0, lglWrites: 1, deferred: 0, lgl: { email: malformed.email }, lglEntries: { email_addresses: { current: 1, total: 2 } },
          holds: [{ field: 'email', reason: 'lgl-refused' }],
        },
      },
      settled({ lglEntries: { email_addresses: { current: 1, total: 2 } }, holds: [{ field: 'email', reason: 'lgl-refused' }] }),
    ],
  },
  {
    name: 'home-and-mobile-both-written-neither-ambiguous',
    why: 'Step 7, phones: LGL keeps one preferred phone per constituent. VG changing both numbers writes a new Home and a new Mobile and retires the two read; each type then has one current entry, so neither slot reads as ambiguous on the next pass.',
    since: 7,
    ...agreeing(phones),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: [] } },
      {
        edit: { vg: { phone: '401-555-0153', cell: '401-555-0154' } },
        run: 'full',
        expect: {
          writes: 0, lglWrites: 1, deferred: 0, lgl: { phones: { phone: '401-555-0153', cell: '401-555-0154' } },
          lglEntries: { phone_numbers: { current: 2, total: 4 } }, holds: [],
        },
      },
      settled({ lgl: { phones: { phone: '401-555-0153', cell: '401-555-0154' } }, holds: [] }),
    ],
  },
  {
    name: 'work-number-beside-home-is-not-retired',
    why: 'Step 7, phones: only the number VG dropped is retired. LGL holds a preferred Home number and a Work number. LGL\'s phones are a list (2026-11-19): the Work number fills VG\'s empty cell on the first pass, and the pair agrees on the next. VG\'s new number then replaces the Home one in LGL, and the Work number stays current.',
    since: 7,
    ...agreeing(work, { lgl: { phone_numbers: [{ number: work.phone, type: 'Home', is_preferred: true }, { number: '401-555-0162', type: 'Work' }] } }),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 1, lglWrites: 0, vg: { phones: { phone: work.phone, cell: '401-555-0162' } }, holds: [] } },
      settled({ holds: [] }),
      {
        edit: { vg: { phone: '401-555-0163' } },
        run: 'full',
        expect: {
          writes: 0, lglWrites: 1, deferred: 0, lgl: { phones: { phone: '401-555-0163', cell: '401-555-0162' } },
          lglEntries: { phone_numbers: { current: 2, total: 3 } }, holds: [],
        },
      },
      settled({ holds: [] }),
    ],
  },
  {
    name: 'own-write-comes-back-through-lgl-check-as-same',
    why: 'Step 7, what comes back: the VG check writes VG\'s email to LGL, which moves the constituent\'s updated_at; the next LGL check reads it back, finds it the same as the memory, and writes nothing either way.',
    since: 7,
    runAlone: true,
    ...agreeing(ownWrite),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: [] } },
      {
        edit: { vg: { email: 'sabine.t@example.org' } },
        run: 'vg-check',
        expect: { writes: 0, lglWrites: 1, deferred: 0, lgl: { email: 'sabine.t@example.org' }, holds: [] },
      },
      { run: 'lgl-check', expect: { writes: 0, lglWrites: 0, deferred: 0, vg: { email: 'sabine.t@example.org' }, holds: [] } },
    ],
  },
  {
    name: 'lgl-edited-between-plan-and-write-is-stale',
    why: 'Step 7, applying: a field LGL changed after the plan read it is stale and not written. The harness edits only between passes, never inside one between its plan and its write, so this cannot be staged here; the stale check rests on the unit tests (test/lgl-vg/apply-lgl.test.js, "stale field is skipped and nothing is sent"). Phase 2 states what a stale write would leave and fails KNOWN: the write goes through.',
    since: 7,
    known: 'the harness cannot place an LGL edit between a pass\'s plan and its write; the stale check is unit-tested',
    ...agreeing(stale),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: [] } },
      {
        edit: { vg: { email: 'e.pilkington@example.org' } },
        run: 'full',
        expect: { writes: 0, lglWrites: 1, lgl: { email: stale.email }, holds: [] },
      },
    ],
  },
  {
    name: 'flapping-is-held',
    why: 'Step 7, Guards (Flapping): more than three LGL writes of one person\'s field in thirty days holds it flapping, and LGL keeps its value. The four earlier writes are seeded as written rows of the LGL write log, each from a run of its own (edit syncLog), then VG changes the email.',
    since: 7,
    ...agreeing(flapping),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: [] } },
      {
        edit: { syncLog: { field: 'email', runs: 4 }, vg: { email: 'g.ashcombe@example.org' } },
        run: 'full',
        expect: { writes: 0, lglWrites: 0, deferred: 0, vg: { email: 'g.ashcombe@example.org' }, lgl: { email: flapping.email }, holds: [{ field: 'email', reason: 'flapping' }] },
      },
      { run: 'full', expect: { writes: 0, lglWrites: 0, lgl: { email: flapping.email }, holds: [{ field: 'email', reason: 'flapping' }] } },
    ],
  },
  {
    name: 'not-on-allow-list-is-deferred',
    why: 'Step 7, LGL_WRITE_ALLOW: a write to a constituent not on the allow-list is deferred (note not-allowed) and nothing is sent. Phase 2 runs the service with LGL_WRITE_ALLOW naming another id, through the phase env (set in the service\'s environment, which wins over .env.harness); phase 3, back on .env.harness\'s "all", writes it.',
    since: 7,
    runAlone: true,
    ...agreeing(notAllowed),
    gifts: [GIFT],
    phases: [
      { run: 'full', expect: { writes: 0, holds: [] } },
      {
        edit: { vg: { email: 'c.bramblecote@example.org' } },
        run: 'full',
        env: { LGL_WRITE_ALLOW: '1' },
        expect: { writes: 0, lglWrites: 0, deferred: 1, lgl: { email: notAllowed.email }, lglEntries: { email_addresses: { current: 1, total: 1 } }, holds: [] },
      },
      { run: 'full', expect: { writes: 0, lglWrites: 1, deferred: 0, lgl: { email: 'c.bramblecote@example.org' }, holds: [] } },
    ],
  },
]
