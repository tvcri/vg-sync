import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { planLinked } from '../../src/lgl-vg/plan.js'
import { reconcileHolds } from '../../src/lgl-vg/holds.js'
import { parsePolicy } from '../../src/lgl-vg/policy.js'
import { FIELDS, lglFields } from '../../src/lgl-vg/fields.js'

const policyText = readFileSync(new URL('../../policy.json', import.meta.url), 'utf8')
const policy = parsePolicy(policyText)
const config = { lgl: { membershipFundId: 5, paypalPaymentTypeId: 2 } }

const con = (o = {}) => ({
  id: 101, first_name: 'Jane', last_name: 'Doe', nick_name: null, suffix: null,
  is_deceased: false, deceased_date: null, is_org: false,
  email_addresses: [{ id: 11, address: 'jane@example.org', is_preferred: true }],
  street_addresses: [{ id: 12, street: '12 Elm St', city: 'Springfield', state: 'RI', zip5: '99999', is_preferred: true }],
  phone_numbers: [],
  ...o,
})
const per = ({ detail, ...o } = {}) => ({
  personId: '7', deceased: false, email: 'jane@example.org', phone: { phone: null, cell: null },
  donor: { lglConstituentId: '101', lastGiftDate: '2026-01-05' },
  ...o,
  detail: {
    firstName: 'Jane', lastName: 'Doe', suffix: null, nickname: null,
    street: '12 Elm St', unit: null, city: 'Springfield', state: 'RI', zip: '99999', deceasedDate: null,
    ...detail,
  },
})
const gift = (constituent_id, received_date, id = 1) => ({ id, constituent_id, received_date, gift_type_id: 1, fund_id: 9, payment_type_id: 1 })
const mem = (field, value, o = {}) => ({ personId: '7', field, lglConstituentId: '101', value, lglEntryId: null, agreedAt: '2026-11-01T00:00:00Z', ...o })
// memory rows saying every field was agreed at the constituent's current LGL values
const agreedAt = (c, personId = '7') => FIELDS.map((f) => mem(f, lglFields(c).values[f], { personId }))
const fp = (arr) => createHash('sha256').update(JSON.stringify(arr)).digest('hex').slice(0, 32)

const plan = ({ constituents = [con()], gifts = [gift(101, '2026-01-05')], persons = [per()], memory = [], refusals = [] } = {}) =>
  planLinked({ constituents, gifts, persons, memory, refusals, policy, config })
const decisionsFor = (p, field) => p.decisions.filter((d) => d.field === field)

test('no memory and equal values: an agree row for each field, no write, no hold', () => {
  const p = plan()
  assert.equal(p.writes.length, 0)
  assert.equal(p.holds.length, 0)
  assert.deepEqual(p.agree.map((r) => r.field), FIELDS)
  assert.deepEqual(p.agree.find((r) => r.field === 'firstName'), { personId: '7', field: 'firstName', lglConstituentId: '101', value: 'Jane', lglEntryId: null })
  assert.equal(p.agree.find((r) => r.field === 'address').lglEntryId, '12')
  assert.equal(p.agree.find((r) => r.field === 'email').lglEntryId, '11')
  assert.deepEqual(p.agree.find((r) => r.field === 'address').value, { street: '12 Elm St', unit: null, city: 'Springfield', state: 'RI', zip: '99999' })
  assert.ok(p.decisions.every((d) => d.outcome === 'record' && d.case === 'first-match'))
  assert.equal(p.counts.fields.email['first-match'], 1)
})

test('all fields at the agreed value: same is neither stored nor logged', () => {
  const p = plan({ memory: agreedAt(con()) })
  assert.deepEqual([p.decisions, p.writes, p.agree, p.holds], [[], [], [], []])
  assert.equal(p.counts.fields.firstName.same, 1)
})

test('LGL changed a first name: a person write with its memory row', () => {
  const c = con({ first_name: 'Janet' })
  const p = plan({ constituents: [c], memory: agreedAt(con()) })
  assert.equal(p.writes.length, 1)
  const w = p.writes[0]
  assert.equal(w.kind, 'person')
  assert.equal(w.personId, '7')
  assert.equal(w.constituentId, '101')
  assert.equal(w.address, null)
  assert.deepEqual(Object.keys(w.fields), ['firstName'])
  assert.deepEqual(w.fields.firstName.body, { firstName: 'Janet' })
  assert.equal(w.fields.firstName.expect, 'jane')
  assert.equal(w.fields.firstName.agree.value, 'Janet')
  assert.equal(w.fields.firstName.fingerprint, fp(['janet', 'jane', 'jane']))
  const [d] = decisionsFor(p, 'firstName')
  assert.equal(d.case, 'lgl-changed')
  assert.equal(d.action, 'to-vg')
  assert.equal(d.outcome, 'write-vg')
  assert.deepEqual(p.agree, [])
})

test('VG changed only: deferred, nothing else', () => {
  const p = plan({ persons: [per({ detail: { lastName: 'Roe' } })], memory: agreedAt(con()) })
  assert.deepEqual([p.writes, p.agree, p.holds], [[], [], []])
  const [d] = p.decisions
  assert.equal(p.decisions.length, 1)
  assert.equal(d.case, 'vg-changed')
  assert.equal(d.action, 'to-lgl')
  assert.equal(d.outcome, 'deferred')
  assert.equal(p.counts.deferred, 1)
})

test('nickname never agreed: hold never-agreed', () => {
  const p = plan({ constituents: [con({ nick_name: 'Janie' })] })
  const h = p.holds.filter((x) => x.field === 'nickname')
  assert.equal(h.length, 1)
  assert.equal(h[0].reason, 'never-agreed')
  assert.equal(h[0].personId, '7')
  assert.equal(h[0].lglConstituentId, '101')
  assert.equal(h[0].fingerprint, fp(['janie', '', null]))
  assert.deepEqual([h[0].detail.lgl, h[0].detail.vg], ['Janie', null])
  assert.ok(!p.agree.some((r) => r.field === 'nickname'))
})

test('email never agreed: held when VG has none, deferred when VG has one', () => {
  const empty = plan({ persons: [per({ email: null })] })
  assert.deepEqual(empty.holds.map((h) => [h.field, h.reason]), [['email', 'never-agreed']])
  const set = plan({ persons: [per({ email: 'jdoe@example.org' })] })
  assert.equal(set.holds.length, 0)
  const [d] = decisionsFor(set, 'email')
  assert.equal(d.action, 'to-lgl-else-hold')
  assert.equal(d.outcome, 'deferred')
})

test('phones never agreed: LGL number merged into an empty VG slot, no memory, VG-only number deferred', () => {
  const c = con({ phone_numbers: [{ id: 13, number: '401-555-0101', phone_type_name: 'Home', is_preferred: true }] })
  const p = plan({ constituents: [c], persons: [per({ phone: { phone: null, cell: '401-555-0102' } })] })
  assert.equal(p.writes.length, 1)
  const f = p.writes[0].fields.phones
  assert.deepEqual(f.body, { phone: '401-555-0101', cell: '401-555-0102' })
  assert.equal(f.agree, null)
  assert.equal(f.expect, '4015550102')
  const ds = decisionsFor(p, 'phones')
  assert.deepEqual(ds.map((d) => [d.action, d.outcome]), [['merge', 'write-vg'], ['merge', 'deferred']])
  assert.equal(p.holds.length, 0)
})

test('phones merge that ends equal to LGL carries a memory row', () => {
  const c = con({ phone_numbers: [{ id: 13, number: '401-555-0101', phone_type_name: 'Home', is_preferred: true }] })
  const p = plan({ constituents: [c] })
  const f = p.writes[0].fields.phones
  assert.deepEqual(f.body, { phone: '401-555-0101', cell: null })
  assert.deepEqual(f.agree.value, { phone: '401-555-0101', cell: null })
  assert.equal(decisionsFor(p, 'phones').length, 1)
})

test('phones merge with no free slot: hold phones-no-slot', () => {
  const c = con({ phone_numbers: [{ id: 13, number: '401-555-0101', phone_type_name: 'Home', is_preferred: true }] })
  const p = plan({ constituents: [c], persons: [per({ phone: { phone: '401-555-0103', cell: '401-555-0104' } })] })
  assert.equal(p.writes.length, 0)
  assert.deepEqual(p.holds.map((h) => [h.field, h.reason]), [['phones', 'phones-no-slot']])
})

test('deceased: toward the marked side, and never removed', () => {
  const dead = con({ is_deceased: true, deceased_date: '2026-03-01' })
  const toVg = plan({ constituents: [dead] })
  assert.deepEqual(toVg.writes[0].fields.deceased.body, { deceased: true, deceasedDate: '2026-03-01' })
  assert.equal(decisionsFor(toVg, 'deceased')[0].action, 'toward-deceased')

  const vgDead = per({ deceased: true, detail: { deceasedDate: '2026-03-01' } })
  const toLgl = plan({ persons: [vgDead] })
  assert.equal(toLgl.writes.length, 0)
  assert.equal(decisionsFor(toLgl, 'deceased')[0].outcome, 'deferred')

  const p = plan({ persons: [vgDead], memory: agreedAt(dead) })
  assert.equal(p.writes.length, 0)
  const [d] = decisionsFor(p, 'deceased')
  assert.equal(d.case, 'lgl-changed')
  assert.deepEqual(p.holds.map((h) => [h.field, h.reason]), [['deceased', 'deceased-removed']])
})

test('first name changed in LGL would drop the VG nickname: hold lost-nickname', () => {
  const was = con({ first_name: 'Robert' })
  const p = plan({
    constituents: [con({ first_name: 'Rob' })],
    persons: [per({ detail: { firstName: 'Robert (Bob)' } })],
    memory: agreedAt(was),
  })
  assert.equal(p.writes.length, 0)
  assert.deepEqual(p.holds.map((h) => [h.field, h.reason]), [['firstName', 'lost-nickname']])
})

test('an unclean LGL email after agreement, VG unchanged: lgl-changed is to-vg, so the guard holds unclean', () => {
  const p = plan({
    constituents: [con({ email_addresses: [{ id: 11, address: 'jane@', is_preferred: true }] })],
    memory: agreedAt(con()),
  })
  assert.deepEqual(p.holds.map((h) => [h.field, h.reason]), [['email', 'unclean']])
  assert.ok(!p.agree.some((r) => r.field === 'email'))
  assert.equal(p.writes.length, 0)
  const [d] = decisionsFor(p, 'email')
  assert.equal(d.case, 'lgl-changed')
  assert.equal(d.outcome, 'hold')
  assert.equal(p.counts.fields.email.unclean, 1)
})

test('the unclean guard blocks to-vg only: a never-agreed address with an unclean LGL value goes to-lgl (deferred), no hold', () => {
  const p = plan({ constituents: [con({ street_addresses: [{ id: 12, street: '12 Elm St', city: 'Springfield 2', state: 'RI', zip5: '99999', is_preferred: true }] })] })
  assert.deepEqual(p.holds, [])
  assert.equal(p.writes.length, 0)
  const [d] = decisionsFor(p, 'address')
  assert.deepEqual([d.case, d.action, d.outcome], ['never-agreed', 'to-lgl', 'deferred'])
})

test('the unclean guard: VG changed after agreement while LGL went unclean is both-changed, to-lgl (deferred), no hold', () => {
  const p = plan({
    constituents: [con({ street_addresses: [{ id: 12, street: '12 Elm St', city: 'Springfield 2', state: 'RI', zip5: '99999', is_preferred: true }] })],
    persons: [per({ detail: { street: '40 Oak Ave' } })],
    memory: agreedAt(con()),
  })
  assert.deepEqual(p.holds, [])
  const [d] = decisionsFor(p, 'address')
  assert.deepEqual([d.case, d.action, d.outcome], ['both-changed', 'to-lgl', 'deferred'])
})

test('the unclean guard holds a merge too: an unclean LGL phone never-agreed with an empty VG slot is held unclean', () => {
  const p = plan({ constituents: [con({ phone_numbers: [{ id: 15, number: '555-01', phone_type_name: 'Home' }] })] })
  assert.deepEqual(p.holds.map((h) => [h.field, h.reason]), [['phones', 'unclean']])
  assert.equal(p.writes.length, 0)
})

test('an unclean hold carries LGL\'s raw value, and a different unclean value gives a different fingerprint', () => {
  const bad = (address) => plan({
    constituents: [con({ email_addresses: [{ id: 11, address, is_preferred: true }] })],
    memory: agreedAt(con()),
  }).holds[0]
  const a = bad('jane@')
  const b = bad('jane@example')
  assert.equal(a.reason, 'unclean')
  assert.equal(a.detail.lgl, 'jane@')
  assert.equal(b.detail.lgl, 'jane@example')
  assert.notEqual(a.fingerprint, b.fingerprint)
  assert.equal(bad('jane@').fingerprint, a.fingerprint)
})

test('malformed takes priority: an unclean never-agreed email with VG empty is held unclean, not never-agreed', () => {
  const p = plan({
    constituents: [con({ email_addresses: [{ id: 11, address: 'jane@', is_preferred: true }] })],
    persons: [per({ email: null })],
  })
  assert.deepEqual(p.holds.map((h) => [h.field, h.reason]), [['email', 'unclean']])
  assert.equal(p.holds[0].detail.case, 'never-agreed')
  assert.equal(p.holds[0].detail.lgl, 'jane@')
  assert.equal(p.writes.length, 0)
})

test('an ambiguous LGL entry is still held whatever the policy', () => {
  const two = [{ id: 11, address: 'jane@example.org' }, { id: 13, address: 'jd@example.org' }]
  const p = plan({ constituents: [con({ email_addresses: two })] })
  assert.deepEqual(p.holds.map((h) => [h.field, h.reason]), [['email', 'ambiguous']])
})

test('a memory row from another constituent is ignored', () => {
  const p = plan({ memory: [mem('firstName', 'Janet', { lglConstituentId: '999' })] })
  const [d] = decisionsFor(p, 'firstName')
  assert.equal(d.case, 'first-match')
  assert.equal(p.writes.length, 0)
})

const couplePersons = (o2 = {}) => [
  per({ personId: '7', detail: { firstName: 'Pat', lastName: 'Doe' } }),
  per({ personId: '8', ...o2, detail: { firstName: 'Lee', lastName: 'Doe', ...o2.detail } }),
]
const coupleCon = (o = {}) => con({ first_name: 'Pat and Lee', ...o })
const coupleMemory = (c) => [...agreedAt(c, '7'), ...agreedAt(c, '8')]

test('couple: LGL address changed and both partners at the agreed value: both written', () => {
  const moved = coupleCon({ street_addresses: [{ id: 14, street: '40 Oak Ave', city: 'Springfield', state: 'RI', zip5: '99999', is_preferred: true }] })
  const p = plan({ constituents: [moved], persons: couplePersons(), memory: coupleMemory(coupleCon()) })
  assert.deepEqual(p.writes.map((w) => w.personId), ['7', '8'])
  for (const w of p.writes) {
    assert.deepEqual(Object.keys(w.fields), ['address'])
    assert.deepEqual(w.address, { street: '40 Oak Ave', city: 'Springfield', state: 'RI', zip: '99999' })
    assert.equal(w.fields.address.agree.lglEntryId, '14')
  }
  assert.equal(p.counts.couples, 1)
  assert.equal(p.counts.pairs, 2)
})

test('couple: one partner also changed the address in VG: couple holds, no writes', () => {
  const moved = coupleCon({ street_addresses: [{ id: 14, street: '40 Oak Ave', city: 'Springfield', state: 'RI', zip5: '99999', is_preferred: true }] })
  const persons = couplePersons({ detail: { street: '9 Pine St' } })
  const p = plan({ constituents: [moved], persons, memory: coupleMemory(coupleCon()) })
  assert.equal(p.writes.length, 0)
  const address = p.holds.filter((h) => h.field === 'address')
  assert.deepEqual(address.map((h) => [h.personId, h.reason]), [['7', 'couple'], ['8', 'couple']])
})

test('couple: the setting couple-lgl-changed other than to-vg holds a shared to-vg', () => {
  const moved = coupleCon({ street_addresses: [{ id: 14, street: '40 Oak Ave', city: 'Springfield', state: 'RI', zip5: '99999', is_preferred: true }] })
  const data = JSON.parse(policyText)
  data.settings['couple-lgl-changed'] = 'hold'
  const p = planLinked({
    constituents: [moved], gifts: [gift(101, '2026-01-05')], persons: couplePersons(), memory: coupleMemory(coupleCon()),
    refusals: [], policy: parsePolicy(JSON.stringify(data)), config,
  })
  assert.equal(p.writes.length, 0)
  assert.deepEqual(p.holds.filter((h) => h.field === 'address').map((h) => [h.personId, h.reason]), [['7', 'couple'], ['8', 'couple']])
})

test('couple: first names differ from LGL: couple hold, not never-agreed', () => {
  const p = plan({ constituents: [coupleCon()], persons: couplePersons() })
  const h = p.holds.filter((x) => x.field === 'firstName')
  assert.deepEqual(h.map((x) => [x.personId, x.reason]), [['7', 'couple'], ['8', 'couple']])
  assert.equal(p.holds.length, 2)
  assert.ok(p.agree.some((r) => r.personId === '8' && r.field === 'lastName'))
})

test('an open vg-refused hold with the same fingerprint: no write, the hold desired again', () => {
  const c = con({ first_name: 'Janet' })
  const refusal = {
    holdId: '55', lglConstituentId: '101', personId: '7', field: 'firstName', reason: 'vg-refused',
    detail: { error: 'VG PATCH /persons → 422' }, fingerprint: fp(['janet', 'jane', 'jane']), state: 'open',
  }
  const p = plan({ constituents: [c], memory: agreedAt(con()), refusals: [refusal] })
  assert.equal(p.writes.length, 0)
  assert.deepEqual(p.holds, [{
    lglConstituentId: '101', personId: '7', field: 'firstName', reason: 'vg-refused',
    fingerprint: refusal.fingerprint, detail: refusal.detail,
  }])
  const other = plan({ constituents: [con({ first_name: 'Janine' })], memory: agreedAt(con()), refusals: [refusal] })
  assert.equal(other.writes.length, 1)
  assert.equal(other.holds.length, 0)
})

test('a dismissed vg-refused hold with the same fingerprint: no write, and reconciling leaves it dismissed', () => {
  const c = con({ first_name: 'Janet' })
  const refusal = {
    holdId: '56', lglConstituentId: '101', personId: '7', field: 'firstName', reason: 'vg-refused',
    detail: { error: 'VG PATCH /persons → 422' }, fingerprint: fp(['janet', 'jane', 'jane']), state: 'dismissed',
  }
  const p = plan({ constituents: [c], memory: agreedAt(con()), refusals: [refusal] })
  assert.equal(p.writes.length, 0)
  assert.equal(p.counts.peopleChanged, 0)
  const r = reconcileHolds(p.holds, [refusal])
  assert.deepEqual([r.open, r.patch], [[], []])
  assert.equal(r.counts.stillDismissed, 1)
  // a different LGL value is a different write: no longer suppressed
  assert.equal(plan({ constituents: [con({ first_name: 'Janine' })], memory: agreedAt(con()), refusals: [refusal] }).writes.length, 1)
})

test('an open or dismissed vg-refused hold on a last gift date suppresses the donor write', () => {
  const memory = agreedAt(con())
  const gifts = [gift(101, '2026-01-05'), gift(101, '2026-10-20', 2)]
  for (const state of ['open', 'dismissed']) {
    const refusal = {
      holdId: '57', lglConstituentId: '101', personId: '7', field: 'lastGiftDate', reason: 'vg-refused',
      detail: { error: 'no' }, fingerprint: fp(['2026-10-20', '2026-01-05', null]), state,
    }
    const p = plan({ gifts, memory, refusals: [refusal] })
    assert.deepEqual(p.writes, [], state)
    const r = reconcileHolds(p.holds, [refusal])
    assert.equal(r.open.length, 0, state)
    assert.ok(!r.patch.some((x) => x.state === 'open'), state)
  }
})

test('last gift date: a newer gift is a donor write, the same date nothing', () => {
  const memory = agreedAt(con())
  const p = plan({ gifts: [gift(101, '2026-01-05'), gift(101, '2026-10-20', 2)], memory })
  assert.deepEqual(p.writes, [{
    kind: 'donor', personId: '7', constituentId: '101',
    body: { lglConstituentId: '101', lastGiftDate: '2026-10-20' }, expect: '2026-01-05',
    fingerprint: fp(['2026-10-20', '2026-01-05', null]),
  }])
  const [d] = p.decisions
  assert.deepEqual([d.kind, d.outcome, d.lgl, d.vg], ['lastGiftDate', 'write-vg', '2026-10-20', '2026-01-05'])
  assert.deepEqual(plan({ memory }).writes, [])
})

test('records: a missing constituent is unlinked (planUnlinked decides unlink or follow), one no longer a donor is held', () => {
  const missing = plan({ constituents: [] })
  assert.deepEqual(missing.unlinks, [{ personId: '7', constituentId: '101', reason: 'lgl-missing' }])
  assert.deepEqual([missing.decisions, missing.writes, missing.holds, missing.agree], [[], [], [], []])
  assert.equal(missing.counts.pairs, 0)

  const lapsed = plan({ gifts: [], memory: agreedAt(con()), persons: [per({ donor: { lglConstituentId: '101', lastGiftDate: null } })] })
  assert.deepEqual(lapsed.holds, [{
    lglConstituentId: '101', personId: '7', field: null, reason: 'no-longer-donor',
    fingerprint: fp(['no-longer-donor', '101']), detail: { lastGiftDate: null },
  }])
})

test('no counting gifts: no donor write clears VG last gift date, the record rule still applies', () => {
  const p = plan({ gifts: [], memory: agreedAt(con()) })
  assert.deepEqual(p.writes, [])
  assert.ok(!p.decisions.some((d) => d.kind === 'lastGiftDate'))
  assert.deepEqual(p.holds.map((h) => [h.personId, h.field, h.reason]), [['7', null, 'no-longer-donor']])
})

test('counts: a person with a field write and a donor write is one person changed', () => {
  const p = plan({ constituents: [con({ first_name: 'Janet' })], gifts: [gift(101, '2026-10-20')], memory: agreedAt(con()) })
  assert.equal(p.counts.writesPlanned, 2)
  assert.equal(p.counts.peopleChanged, 1)
  assert.equal(p.counts.holds, 0)
})
