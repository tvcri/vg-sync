import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { planLinked } from '../../src/lgl-vg/plan.js'
import { reconcileHolds } from '../../src/lgl-vg/holds.js'
import { parsePolicy } from '../../src/lgl-vg/policy.js'
import { FIELDS, lglFields, comparable, lglExpect } from '../../src/lgl-vg/fields.js'

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

const plan = ({ constituents = [con()], gifts = [gift(101, '2026-01-05')], persons = [per()], memory = [], refusals = [], ...lgl } = {}) =>
  planLinked({ constituents, gifts, persons, memory, refusals, policy, config, ...lgl })
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

test('phones merge that ends equal to LGL records no memory row: the next run finds first-match', () => {
  const c = con({ phone_numbers: [{ id: 13, number: '401-555-0101', phone_type_name: 'Home', is_preferred: true }] })
  const p = plan({ constituents: [c] })
  const f = p.writes[0].fields.phones
  assert.deepEqual(f.body, { phone: '401-555-0101', cell: null })
  assert.equal(f.agree, null)
  assert.equal(decisionsFor(p, 'phones').length, 1)
  assert.deepEqual(p.lglWrites, [])
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

// --- step 7: writes to LGL ---

const on = { lglSend: () => true, writeLgl: true }
const newEmail = () => per({ email: 'jdoe@example.org' })

test('vg-changed email with LGL writing on plans an LGL write, not deferred', () => {
  const p = plan({ persons: [newEmail()], memory: agreedAt(con()), ...on })
  assert.deepEqual(p.lglWrites, [{
    kind: 'lgl', constituentId: '101', personIds: ['7'], field: 'email', case: 'vg-changed',
    value: 'jdoe@example.org', expect: 'jane@example.org', fingerprint: fp(['email', 'jdoe@example.org']), merge: false, send: true,
  }])
  const [d] = decisionsFor(p, 'email')
  assert.deepEqual([d.case, d.action, d.outcome, d.note], ['vg-changed', 'to-lgl', 'write-lgl', undefined])
  assert.deepEqual(d.calls, [
    'LGL POST /constituents/101/email_addresses {"address":"jdoe@example.org","email_type_name":"Home","is_preferred":true}',
    'LGL PATCH /email_addresses/11 {"not_current":true}',
  ])
  assert.deepEqual([p.writes, p.agree, p.holds], [[], [], []])
  assert.equal(p.counts.lglWritesPlanned, 1)
  assert.equal(p.counts.deferred, 0)
})

test('with LGL writing off the same write is deferred, with its calls printed', () => {
  const p = plan({ persons: [newEmail()], memory: agreedAt(con()) })
  const [d] = decisionsFor(p, 'email')
  assert.deepEqual([d.outcome, d.note], ['deferred', 'write-lgl off'])
  assert.ok(d.calls[0].startsWith('LGL POST /constituents/101/email_addresses'))
  assert.equal(d.calls.length, 2)
  assert.equal(p.lglWrites.length, 1)
  assert.equal(p.lglWrites[0].send, false)
  assert.equal(p.counts.lglWritesPlanned, 0)
  assert.equal(p.counts.deferred, 1)
})

test('a constituent not on the allow-list is deferred not-allowed', () => {
  const asked = []
  const p = plan({ persons: [newEmail()], memory: agreedAt(con()), writeLgl: true, lglSend: (id) => { asked.push(id); return id === '202' } })
  const [d] = decisionsFor(p, 'email')
  assert.deepEqual([d.outcome, d.note], ['deferred', 'not-allowed'])
  assert.equal(d.calls.length, 2)
  assert.deepEqual(asked, ['101'])
  assert.equal(p.lglWrites[0].send, false)
  assert.equal(p.counts.lglWritesPlanned, 0)
})

test('never-agreed address to-lgl replacing a PO box is held po-box', () => {
  for (const street of ['PO Box 12', 'P.O. Box 12']) {
    const c = con({ street_addresses: [{ id: 12, street, city: 'Springfield', state: 'RI', zip5: '99999', is_preferred: true }] })
    const p = plan({ constituents: [c], ...on })
    const lglC = comparable('address', lglFields(c).values.address)
    const vgC = comparable('address', { street: '12 Elm St', unit: null, city: 'Springfield', state: 'RI', zip: '99999' })
    assert.deepEqual(p.holds.map((h) => [h.field, h.reason, h.fingerprint]), [['address', 'po-box', fp([lglC, vgC, null])]], street)
    assert.equal(p.holds[0].detail.case, 'never-agreed')
    assert.deepEqual(p.lglWrites, [], street)
    assert.equal(decisionsFor(p, 'address')[0].outcome, 'hold')
  }
  // a street that is not a PO box is written
  const c = con({ street_addresses: [{ id: 12, street: '40 Oak Ave', city: 'Springfield', state: 'RI', zip5: '99999', is_preferred: true }] })
  assert.deepEqual(plan({ constituents: [c], ...on }).lglWrites.map((w) => w.field), ['address'])
})

test('an address written to LGL carries a two-letter state; a VG state that is not one fails the run', () => {
  const c = con({ street_addresses: [{ id: 12, street: '40 Oak Ave', city: 'Springfield', state: 'RI', zip5: '99999', is_preferred: true }] })
  const p = plan({ constituents: [c], persons: [per({ detail: { state: 'Rhode Island', unit: 'Apt 2' } })], ...on })
  assert.deepEqual(p.lglWrites[0].value, { street: '12 Elm St', unit: 'Apt 2', city: 'Springfield', state: 'RI', zip: '99999' })
  assert.match(decisionsFor(p, 'address')[0].calls[0], /"state":"RI"/)
  assert.throws(() => plan({ constituents: [c], persons: [per({ detail: { state: 'Atlantis' } })], ...on }), /person 7.*address.*Atlantis/)
})

test('an unconvertible VG state does not fail the run when a guard holds the write', () => {
  const box = con({ street_addresses: [{ id: 12, street: 'PO Box 12', city: 'Springfield', state: 'RI', zip5: '99999', is_preferred: true }] })
  const persons = [per({ detail: { state: 'Atlantis' } })]
  const p = plan({ constituents: [box], persons, ...on })
  assert.deepEqual(p.holds.map((h) => [h.field, h.reason]), [['address', 'po-box']])
  assert.deepEqual(p.lglWrites, [])
  const c = con({ street_addresses: [{ id: 12, street: '40 Oak Ave', city: 'Springfield', state: 'RI', zip5: '99999', is_preferred: true }] })
  const flapping = plan({ constituents: [c], persons, lglWriteCounts: new Map([['7|address', 4]]), ...on })
  assert.deepEqual(flapping.holds.map((h) => [h.field, h.reason]), [['address', 'flapping']])
  // the refusal's fingerprint is built from VG's value as read
  const vgAddress = { street: '12 Elm St', unit: null, city: 'Springfield', state: 'Atlantis', zip: '99999' }
  const refusal = {
    holdId: '59', lglConstituentId: '101', personId: '7', field: 'address', reason: 'lgl-refused',
    detail: { error: 'no' }, fingerprint: fp(['address', comparable('address', vgAddress)]), state: 'open',
  }
  const refused = plan({ constituents: [c], persons, refusals: [refusal], ...on })
  assert.deepEqual(refused.holds.map((h) => [h.field, h.reason]), [['address', 'lgl-refused']])
})

test('an LGL write that would make no call is a skip decision, noted', () => {
  // LGL's home number is unclean (eleven digits) but its last ten are VG's new number
  const c = con({ phone_numbers: [{ id: 13, number: '2401-555-0101', phone_type_name: 'Home', is_preferred: true }] })
  const p = plan({
    constituents: [c], persons: [per({ phone: { phone: '401-555-0101', cell: null } })],
    memory: [...agreedAt(con()).filter((r) => r.field !== 'phones'), mem('phones', { phone: '401-555-0199', cell: null })], ...on,
  })
  const [d] = decisionsFor(p, 'phones')
  assert.deepEqual([d.case, d.action, d.outcome, d.note], ['both-changed', 'to-lgl', 'skip', 'no calls'])
  assert.deepEqual([p.lglWrites, p.holds], [[], []])
})

test('an unconvertible VG state is deferred with a note when the write is not sent', () => {
  const c = con({ street_addresses: [{ id: 12, street: '40 Oak Ave', city: 'Springfield', state: 'RI', zip5: '99999', is_preferred: true }] })
  const persons = [per({ detail: { state: 'Atlantis' } })]
  for (const lgl of [{}, { writeLgl: true, lglSend: () => false }]) {
    const p = plan({ constituents: [c], persons, ...lgl })
    const [d] = decisionsFor(p, 'address')
    assert.deepEqual([d.outcome, d.note, d.calls], ['deferred', 'vg state not a code', []])
    assert.deepEqual(p.lglWrites, [])
    assert.equal(p.counts.deferred, 1)
    assert.equal(p.counts.peopleChanged, 0)
  }
})

test('toward-deceased with VG deceased and LGL not plans an LGL write of the mark', () => {
  const p = plan({ persons: [per({ deceased: true, detail: { deceasedDate: '2026-03-01' } })], ...on })
  assert.deepEqual(p.writes, [])
  const [w] = p.lglWrites
  assert.deepEqual([w.field, w.case, w.value, w.expect, w.merge], ['deceased', 'never-agreed', { flag: true, date: '2026-03-01' }, '0', false])
  const [d] = decisionsFor(p, 'deceased')
  assert.deepEqual([d.action, d.outcome], ['toward-deceased', 'write-lgl'])
  assert.deepEqual(d.calls, ['LGL PATCH /constituents/101 {"is_deceased":true,"deceased_date":"2026-03-01"}'])
})

test('toward-deceased with both marked and different dates is held, not written either way', () => {
  const dead = con({ is_deceased: true, deceased_date: '2026-03-01' })
  const p = plan({ constituents: [dead], persons: [per({ deceased: true, detail: { deceasedDate: '2026-04-01' } })], ...on })
  assert.deepEqual([p.writes, p.lglWrites], [[], []])
  assert.deepEqual(p.holds.map((h) => [h.field, h.reason]), [['deceased', 'never-agreed']])
})

test('a VG change that removes a deceased mark is never written to LGL: held deceased-removed', () => {
  const dead = con({ is_deceased: true, deceased_date: '2026-03-01' })
  const p = plan({ constituents: [dead], memory: agreedAt(dead), ...on })
  assert.equal(decisionsFor(p, 'deceased')[0].case, 'vg-changed')
  assert.deepEqual(p.holds.map((h) => [h.field, h.reason]), [['deceased', 'deceased-removed']])
  assert.deepEqual(p.lglWrites, [])
})

test('to-lgl-else-hold with VG empty still holds never-agreed', () => {
  const p = plan({ persons: [per({ email: null })], ...on })
  assert.deepEqual(p.holds.map((h) => [h.field, h.reason]), [['email', 'never-agreed']])
  assert.deepEqual(p.lglWrites, [])
  // VG has one: written
  const set = plan({ persons: [newEmail()], ...on })
  assert.deepEqual(set.lglWrites.map((w) => [w.field, w.case, w.value]), [['email', 'never-agreed', 'jdoe@example.org']])
})

test('to-lgl with VG empty is never written: a clear is held under its case', () => {
  // LGL changed the email and VG cleared it: both-changed, to-lgl, VG empty
  const p = plan({ constituents: [con({ email_addresses: [{ id: 13, address: 'jd@example.org', is_preferred: true }] })], persons: [per({ email: null })], memory: agreedAt(con()), ...on })
  assert.deepEqual(p.holds.map((h) => [h.field, h.reason]), [['email', 'both-changed']])
  assert.deepEqual(p.lglWrites, [])
})

test('a phones write where VG emptied a slot LGL still holds is held vg-cleared', () => {
  const c = con({ phone_numbers: [
    { id: 13, number: '401-555-0101', phone_type_name: 'Home', is_preferred: true },
    { id: 14, number: '401-555-0102', phone_type_name: 'Mobile' },
  ] })
  const p = plan({ constituents: [c], persons: [per({ phone: { phone: '401-555-0101', cell: null } })], memory: agreedAt(c), ...on })
  assert.equal(decisionsFor(p, 'phones')[0].case, 'vg-changed')
  assert.deepEqual(p.holds.map((h) => [h.field, h.reason]), [['phones', 'vg-cleared']])
  assert.deepEqual(p.lglWrites, [])
  // VG changed a number and kept both slots: written
  const q = plan({ constituents: [c], persons: [per({ phone: { phone: '401-555-0101', cell: '401-555-0109' } })], memory: agreedAt(c), ...on })
  assert.deepEqual(q.lglWrites.map((w) => [w.field, w.value]), [['phones', { phone: '401-555-0101', cell: '401-555-0109' }]])
  assert.deepEqual(decisionsFor(q, 'phones')[0].calls, [
    'LGL POST /constituents/101/phone_numbers {"number":"401-555-0109","phone_type_name":"Mobile","is_preferred":false}',
    'LGL PATCH /phone_numbers/14 {"not_current":true}',
  ])
})

test('merge plans the VG write and an LGL write of VG-only numbers, and records no memory row', () => {
  const c = con({ phone_numbers: [{ id: 13, number: '401-555-0101', phone_type_name: 'Home', is_preferred: true }] })
  const p = plan({ constituents: [c], persons: [per({ phone: { phone: null, cell: '401-555-0102' } })], ...on })
  assert.deepEqual(p.writes[0].fields.phones.body, { phone: '401-555-0101', cell: '401-555-0102' })
  assert.equal(p.writes[0].fields.phones.agree, null)
  assert.ok(!p.agree.some((r) => r.field === 'phones'))
  assert.equal(p.lglWrites.length, 1)
  const [w] = p.lglWrites
  assert.deepEqual([w.field, w.case, w.merge, w.value, w.send], ['phones', 'never-agreed', true, { phone: null, cell: '401-555-0102' }, true])
  const ds = decisionsFor(p, 'phones')
  assert.deepEqual(ds.map((d) => [d.action, d.outcome]), [['merge', 'write-vg'], ['merge', 'write-lgl']])
  assert.deepEqual(ds[1].calls, ['LGL POST /constituents/101/phone_numbers {"number":"401-555-0102","phone_type_name":"Mobile","is_preferred":false}'])
})

test('merge: a VG-only number LGL has no free type group for is not planned; held phones-no-slot', () => {
  // VG's home number differs from LGL's: LGL's goes to VG's empty cell slot, VG's has no slot in LGL
  const c = con({ phone_numbers: [{ id: 13, number: '401-555-0101', phone_type_name: 'Home', is_preferred: true }] })
  const p = plan({ constituents: [c], persons: [per({ phone: { phone: '401-555-0103', cell: null } })], ...on })
  assert.deepEqual(p.writes[0].fields.phones.body, { phone: '401-555-0103', cell: '401-555-0101' })
  assert.deepEqual(p.lglWrites, [])
  assert.deepEqual(p.holds.map((h) => [h.field, h.reason]), [['phones', 'phones-no-slot']])
})

test('a field written to LGL more than 3 times in 30 days is held flapping', () => {
  const p = plan({ persons: [newEmail()], memory: agreedAt(con()), lglWriteCounts: new Map([['7|email', 4]]), ...on })
  assert.deepEqual(p.lglWrites, [])
  assert.deepEqual(p.holds.map((h) => [h.field, h.reason, h.fingerprint]),
    [['email', 'flapping', fp(['jane@example.org', 'jdoe@example.org', 'jane@example.org'])]])
  assert.equal(p.holds[0].detail.lglWrites, 4)
  assert.equal(decisionsFor(p, 'email')[0].outcome, 'hold')
})

test('3 writes is not flapping', () => {
  const p = plan({ persons: [newEmail()], memory: agreedAt(con()), lglWriteCounts: new Map([['7|email', 3], ['7|address', 9]]), ...on })
  assert.deepEqual(p.lglWrites.map((w) => w.field), ['email'])
  assert.deepEqual(p.holds, [])
})

test('an open or dismissed lgl-refused hold with the same fingerprint suppresses the write and is desired again', () => {
  for (const state of ['open', 'dismissed']) {
    const refusal = {
      holdId: '58', lglConstituentId: '101', personId: '7', field: 'email', reason: 'lgl-refused',
      detail: { error: 'LGL POST → 422' }, fingerprint: fp(['email', 'jdoe@example.org']), state,
    }
    const p = plan({ persons: [newEmail()], memory: agreedAt(con()), refusals: [refusal], ...on })
    assert.deepEqual(p.lglWrites, [], state)
    assert.equal(p.counts.peopleChanged, 0, state)
    assert.deepEqual(p.holds, [{
      lglConstituentId: '101', personId: '7', field: 'email', reason: 'lgl-refused',
      fingerprint: refusal.fingerprint, detail: refusal.detail,
    }], state)
    const r = reconcileHolds(p.holds, [refusal])
    assert.equal(r.open.length, 0, state)
    assert.ok(!r.patch.some((x) => x.state), state) // neither closed nor reopened
    // a new VG value is a new write: tried
    const other = plan({ persons: [per({ email: 'jd2@example.org' })], memory: agreedAt(con()), refusals: [refusal], ...on })
    assert.equal(other.lglWrites.length, 1, state)
    assert.deepEqual(other.holds, [], state)
  }
})

test('lgl-refused fingerprint is the write attempted: field and VG comparable value', () => {
  const a = plan({ persons: [per({ email: 'JDoe@Example.org' })], memory: agreedAt(con()) }).lglWrites[0]
  assert.equal(a.fingerprint, fp(['email', 'jdoe@example.org']))
  // the same write whatever LGL holds: an LGL value moved by a partial write keeps the fingerprint
  const b = plan({
    constituents: [con({ email_addresses: [{ id: 13, address: 'jd@example.org', is_preferred: true }] })],
    persons: [newEmail()], memory: agreedAt(con()),
  }).lglWrites[0]
  assert.equal(b.case, 'both-changed')
  assert.equal(b.fingerprint, a.fingerprint)
})

test('couple: both partners changed to the same value writes LGL once with both person ids', () => {
  const persons = couplePersons({ email: 'pair@example.org' })
  persons[0].email = 'Pair@example.org'
  const p = plan({ constituents: [coupleCon()], persons, memory: coupleMemory(coupleCon()), ...on })
  assert.equal(p.lglWrites.length, 1)
  assert.deepEqual([p.lglWrites[0].personIds, p.lglWrites[0].field, p.lglWrites[0].value], [['7', '8'], 'email', 'Pair@example.org'])
  const ds = decisionsFor(p, 'email')
  assert.deepEqual(ds.map((d) => [d.personId, d.outcome]), [['7', 'write-lgl'], ['8', 'write-lgl']])
  assert.deepEqual(ds[0].calls, ds[1].calls)
  assert.deepEqual(p.holds.filter((h) => h.field === 'email'), [])
  assert.equal(p.counts.peopleChanged, 2)
  assert.equal(p.counts.lglWritesPlanned, 1)
})

test('couple: one partner changed holds, no LGL write', () => {
  const p = plan({ constituents: [coupleCon()], persons: couplePersons({ email: 'pair@example.org' }), memory: coupleMemory(coupleCon()), ...on })
  assert.deepEqual(p.lglWrites, [])
  const email = (x) => x.holds.filter((h) => h.field === 'email').map((h) => [h.personId, h.field, h.reason])
  assert.deepEqual(email(p), [['8', 'email', 'couple']])
  // both changed, to different values: held
  const persons = couplePersons({ email: 'pair@example.org' })
  persons[0].email = 'other@example.org'
  const q = plan({ constituents: [coupleCon()], persons, memory: coupleMemory(coupleCon()), ...on })
  assert.deepEqual(q.lglWrites, [])
  assert.deepEqual(email(q), [['7', 'email', 'couple'], ['8', 'email', 'couple']])
})

test('couple names and deceased are never written to LGL', () => {
  const persons = couplePersons({ deceased: true, detail: { lastName: 'Roe', deceasedDate: '2026-03-01' } })
  persons[0].deceased = true
  persons[0].detail.lastName = 'Roe'
  persons[0].detail.deceasedDate = '2026-03-01'
  const p = plan({ constituents: [coupleCon()], persons, memory: coupleMemory(coupleCon()), ...on })
  assert.deepEqual(p.lglWrites, [])
  assert.deepEqual(p.holds.map((h) => [h.personId, h.field, h.reason]),
    [['7', 'firstName', 'couple'], ['8', 'firstName', 'couple'], ['7', 'lastName', 'couple'], ['8', 'lastName', 'couple'],
      ['7', 'deceased', 'couple'], ['8', 'deceased', 'couple']])
})

test('people changed counts LGL writes that will be sent, not deferred ones', () => {
  const persons = [newEmail()]
  const memory = agreedAt(con())
  assert.equal(plan({ persons, memory, ...on }).counts.peopleChanged, 1)
  assert.equal(plan({ persons, memory }).counts.peopleChanged, 0)
  assert.equal(plan({ persons, memory, writeLgl: true, lglSend: () => false }).counts.peopleChanged, 0)
  // a VG write and a sent LGL write for the same person: one person
  const both = plan({ constituents: [con({ first_name: 'Janet' })], persons, memory, ...on })
  assert.deepEqual([both.writes.length, both.lglWrites.length, both.counts.peopleChanged], [1, 1, 1])
})

test('an unclean LGL value is expected as stored: a change to another unclean value gives another expectation', () => {
  const addr = (city) => con({ street_addresses: [{ id: 12, street: '12 Elm St', city, state: 'RI', zip5: '99999', is_preferred: true }] })
  const expectFor = (c) => plan({ constituents: [c], persons: [per({ detail: { street: '40 Oak Ave' } })], memory: agreedAt(con()), ...on }).lglWrites[0].expect
  const a = expectFor(addr('Springfield 2'))
  const b = expectFor(addr('Springfield 3'))
  assert.notEqual(a, '')
  assert.notEqual(a, b)
  assert.equal(a, lglExpect(lglFields(addr('Springfield 2')), 'address'))
})

test('phones with one unclean slot: an edit of the clean slot gives another expectation', () => {
  const phones = (home) => con({ phone_numbers: [
    { id: 13, number: home, phone_type_name: 'Home', is_preferred: true },
    { id: 14, number: '555-01', phone_type_name: 'Mobile' },
  ] })
  const expectFor = (c) => plan({
    constituents: [c], persons: [per({ phone: { phone: '401-555-0199', cell: '401-555-0188' } })],
    memory: [...agreedAt(con()).filter((r) => r.field !== 'phones'), mem('phones', { phone: '401-555-0101', cell: null })], ...on,
  }).lglWrites.find((w) => w.field === 'phones').expect
  const a = expectFor(phones('401-555-0101'))
  const b = expectFor(phones('401-555-0102'))
  assert.notEqual(a, '')
  assert.notEqual(a, b)
})
