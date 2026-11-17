import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyLglWrites } from '../../src/lgl-vg/apply-lgl.js'
import { comparable, lglFields, lglExpect } from '../../src/lgl-vg/fields.js'
import { fingerprint } from '../../src/lgl-vg/plan.js'

// An LGL constituent as getConstituentFull returns it: the record and its three entry lists.
const con = (o = {}) => ({
  id: 101, first_name: 'Jane', last_name: 'Doe', nick_name: null, suffix: null,
  addressee: 'Jane Doe', salutation: 'Jane', is_deceased: false, deceased_date: null,
  email_addresses: [{ id: 11, address: 'old@example.org', email_type_name: 'Home', is_preferred: true, not_current: false }],
  street_addresses: [],
  phone_numbers: [],
  ...o,
})
const emailW = (o = {}) => ({
  kind: 'lgl', constituentId: '101', personIds: ['7'], field: 'email', case: 'vg-changed',
  value: 'new@example.org', expect: comparable('email', 'old@example.org'),
  fingerprint: fingerprint(['email', comparable('email', 'new@example.org')]), merge: false, send: true, ...o,
})
const nameW = (o = {}) => ({
  kind: 'lgl', constituentId: '101', personIds: ['7'], field: 'firstName', case: 'vg-changed',
  value: 'Janet', expect: comparable('firstName', 'Jane'),
  fingerprint: fingerprint(['firstName', comparable('firstName', 'Janet')]), merge: false, send: true, ...o,
})
const ifDefault = { setting: (name) => (name === 'lgl-addressee' ? 'if-default' : undefined) }

const lglError = (status) => Object.assign(new Error(`LGL call → ${status}: invalid value`), { status })

// records: constituent id -> record (absent answers 404). answer(method, path, body) is LGL's reply
// to a write, or throws. lists: entry kind -> what listEntries returns.
function fakeLgl({ records = { 101: con() }, answer, lists = {}, onCall = () => {} } = {}) {
  const calls = []
  let nextId = 900
  const reply = answer ?? ((method, path, body) => (method === 'POST' ? { id: nextId++, not_current: false, ...body } : { ...body }))
  const send = async (method, path, body) => {
    calls.push([method, path, body])
    onCall(method, path, body)
    return reply(method, path, body)
  }
  return {
    calls,
    getConstituentFull: async (id) => {
      calls.push(['READ', String(id)])
      const r = records[String(id)]
      if (!r) throw lglError(404)
      return structuredClone(r)
    },
    patchConstituent: (id, body) => send('PATCH', `/constituents/${id}`, body),
    addEntry: (id, kind, body) => send('POST', `/constituents/${id}/${kind}`, body),
    patchEntry: (kind, entryId, body) => send('PATCH', `/${kind}/${entryId}`, body),
    listEntries: async (id, kind) => { calls.push(['LIST', `/constituents/${id}/${kind}`]); return lists[kind] ?? [] },
  }
}
function fakeVg({ appendErr = null } = {}) {
  const appends = []
  return {
    appends,
    appendSyncLog: async (rows) => {
      appends.push(rows)
      if (appendErr) throw appendErr
      return rows.length
    },
  }
}
const run = (writes, { lgl = fakeLgl(), vg = fakeVg(), ...o } = {}) =>
  applyLglWrites(writes, { lgl, vg, runId: '42', policy: ifDefault, ...o }).then((r) => ({ r, lgl, vg }))
const sent = (lgl) => lgl.calls.filter((c) => !['READ', 'LIST'].includes(c[0]))

test('writes are grouped by constituent, which is read fresh once', async () => {
  const records = { 101: con(), 102: con({ id: 102 }) }
  const { r, lgl, vg } = await run(
    [emailW(), emailW({ constituentId: '102', personIds: ['8'] }), nameW()],
    { lgl: fakeLgl({ records }) },
  )
  assert.deepEqual(lgl.calls.filter((c) => c[0] === 'READ'), [['READ', '101'], ['READ', '102']])
  // 101's email and name are sent before 102 is read
  assert.deepEqual(lgl.calls.map((c) => c[0] === 'READ' ? `READ ${c[1]}` : `${c[0]} ${c[1]}`), [
    'READ 101', 'POST /constituents/101/email_addresses', 'PATCH /email_addresses/11', 'PATCH /constituents/101',
    'READ 102', 'POST /constituents/102/email_addresses', 'PATCH /email_addresses/11',
  ])
  assert.equal(vg.appends.length, 2)
  assert.deepEqual(vg.appends.map((rows) => [...new Set(rows.map((x) => x.lglConstituentId))]), [['101'], ['102']])
  assert.deepEqual(r.counts, { written: 3, stale: 0, refused: 0 })
  assert.equal(r.stopped, false)
})

test('stale field is skipped and nothing is sent', async () => {
  const logged = []
  // LGL's email moved since the plan read it
  const lgl = fakeLgl({ records: { 101: con({ email_addresses: [{ id: 12, address: 'other@example.org', is_preferred: true, not_current: false }] }) } })
  const { r, vg } = await run([emailW()], { lgl, log: (d) => logged.push(d) })
  assert.deepEqual(sent(lgl), [])
  assert.deepEqual(vg.appends, [])
  assert.deepEqual(r.counts, { written: 0, stale: 1, refused: 0 })
  assert.deepEqual(r.agree, [])
  assert.deepEqual(r.holds, [])
  assert.deepEqual(logged.map((d) => [d.kind, d.personId, d.field, d.outcome]), [['lgl', '7', 'email', 'stale']])
})

test('a gone constituent (404 on the read) is stale, not a failure', async () => {
  const lgl = fakeLgl({ records: { 102: con({ id: 102 }) } })
  const { r, vg } = await run([emailW(), nameW(), emailW({ constituentId: '102' })], { lgl })
  assert.deepEqual(r.counts, { written: 1, stale: 2, refused: 0 })
  assert.deepEqual(sent(lgl).map((c) => c[1]), ['/constituents/102/email_addresses', '/email_addresses/11'])
  assert.equal(vg.appends.length, 1)
})

test('a read that fails otherwise fails the run', async () => {
  const lgl = fakeLgl()
  lgl.getConstituentFull = async () => { throw lglError(503) }
  await assert.rejects(run([emailW()], { lgl }), /503/)
})

test('calls are sent in order; an add\'s new id is what the check reads', async () => {
  // The add's response lacks not_current: the list is read and the new entry found by its id.
  const lgl = fakeLgl({
    answer: (method, path, body) => (method === 'POST' ? { id: 905 } : { ...body }),
    lists: { email_addresses: [
      { id: 11, address: 'old@example.org', is_preferred: false, not_current: false },
      { id: 904, address: 'new@example.org', is_preferred: false, not_current: true },
      { id: 905, address: 'new@example.org', is_preferred: true, not_current: false },
    ] },
  })
  const { r, vg } = await run([emailW()], { lgl })
  assert.deepEqual(lgl.calls, [
    ['READ', '101'],
    ['POST', '/constituents/101/email_addresses', { address: 'new@example.org', email_type_name: 'Home', is_preferred: true }],
    ['LIST', '/constituents/101/email_addresses'],
    ['PATCH', '/email_addresses/11', { not_current: true }],
  ])
  assert.deepEqual(vg.appends[0].map((x) => x.lglEntryId), ['905', '11'])
  assert.equal(r.agree[0].lglEntryId, '905')
  assert.deepEqual(r.counts, { written: 1, stale: 0, refused: 0 })
})

test('an add whose new entry the list lacks is not taken: nothing is retired', async () => {
  const lgl = fakeLgl({ answer: (method, path, body) => (method === 'POST' ? { id: 905 } : { ...body }), lists: { email_addresses: [] } })
  const { r } = await run([emailW()], { lgl })
  assert.deepEqual(sent(lgl).map((c) => c[0]), ['POST'])
  assert.deepEqual(r.counts, { written: 0, stale: 0, refused: 1 })
  assert.equal(r.holds[0].reason, 'lgl-refused')
})

test('a revive is checked like an add', async () => {
  const record = con({ email_addresses: [
    { id: 11, address: 'old@example.org', is_preferred: true, not_current: false },
    { id: 13, address: 'new@example.org', is_preferred: false, not_current: true },
  ] })
  const lgl = fakeLgl({ records: { 101: record } })
  const { r, vg } = await run([emailW()], { lgl })
  assert.deepEqual(sent(lgl), [
    ['PATCH', '/email_addresses/13', { not_current: false, is_preferred: true }],
    ['PATCH', '/email_addresses/11', { not_current: true }],
  ])
  assert.deepEqual(vg.appends[0].map((x) => x.lglEntryId), ['13', '11'])
  assert.equal(r.agree[0].lglEntryId, '13')
})

test('email stored not current keeps the old one and holds', async () => {
  const lgl = fakeLgl({ answer: (method, path, body) => (method === 'POST' ? { id: 905, not_current: true, ...body, is_preferred: false } : { ...body }) })
  const logged = []
  const { r, vg } = await run([emailW({ personIds: ['7', '8'] })], { lgl, log: (d) => logged.push(d) })
  assert.deepEqual(sent(lgl).map((c) => [c[0], c[1]]), [['POST', '/constituents/101/email_addresses']]) // no retire
  assert.deepEqual(r.counts, { written: 0, stale: 0, refused: 1 })
  assert.deepEqual(r.agree, [])
  const fp = fingerprint(['email', comparable('email', 'new@example.org')])
  assert.deepEqual(r.holds.map((h) => [h.lglConstituentId, h.personId, h.field, h.reason, h.fingerprint]), [
    ['101', '7', 'email', 'lgl-refused', fp], ['101', '8', 'email', 'lgl-refused', fp],
  ])
  assert.match(r.holds[0].detail.error, /not current/)
  assert.deepEqual(vg.appends[0].map((x) => [x.personId, x.outcome, x.responseStatus, x.lglEntryId]), [
    ['7', 'refused', 200, '905'], ['8', 'refused', 200, '905'],
  ])
  assert.deepEqual(logged.map((d) => [d.personId, d.outcome]), [['7', 'refused'], ['8', 'refused']])
})

test('a 422 stops that field\'s calls, logs refused and opens lgl-refused', async () => {
  const lgl = fakeLgl({
    answer: (method, path, body) => {
      if (method === 'POST') throw lglError(422)
      return { ...body }
    },
  })
  const { r, vg } = await run([emailW(), nameW()], { lgl })
  // The email's retire is not sent; the name, another field of the same constituent, goes on.
  assert.deepEqual(sent(lgl).map((c) => [c[0], c[1]]), [['POST', '/constituents/101/email_addresses'], ['PATCH', '/constituents/101']])
  assert.deepEqual(r.counts, { written: 1, stale: 0, refused: 1 })
  assert.deepEqual(vg.appends.length, 1)
  assert.deepEqual(vg.appends[0].map((x) => [x.field, x.outcome, x.responseStatus]), [['email', 'refused', 422], ['firstName', 'written', 200]])
  assert.match(vg.appends[0][0].note, /422/)
  assert.deepEqual(r.holds.map((h) => [h.personId, h.field, h.reason, h.fingerprint]), [
    ['7', 'email', 'lgl-refused', fingerprint(['email', comparable('email', 'new@example.org')])],
  ])
  assert.match(r.holds[0].detail.error, /422/)
  assert.deepEqual(r.holds[0].detail.attempted, { method: 'POST', path: '/constituents/101/email_addresses', body: { address: 'new@example.org', email_type_name: 'Home', is_preferred: true } })
  assert.deepEqual(r.agree.map((a) => a.field), ['firstName'])
})

test('a 400 and a 404 are refusals too', async () => {
  for (const status of [400, 404]) {
    const lgl = fakeLgl({ answer: () => { throw lglError(status) } })
    const { r } = await run([nameW()], { lgl })
    assert.deepEqual(r.counts, { written: 0, stale: 0, refused: 1 })
  }
})

test('a 500 after retries fails the run, and the failed call is logged too', async () => {
  const lgl = fakeLgl({
    answer: (method, path, body) => {
      if (path === '/email_addresses/11') throw lglError(500)
      return method === 'POST' ? { id: 905, not_current: false } : { ...body }
    },
  })
  const vg = fakeVg()
  await assert.rejects(run([emailW(), nameW()], { lgl, vg }), /500/)
  assert.deepEqual(sent(lgl).map((c) => c[1]), ['/constituents/101/email_addresses', '/email_addresses/11']) // nothing after
  // the call that went through and the one that failed (LGL may have applied it) are recorded before the run fails
  assert.deepEqual(vg.appends.map((rows) => rows.map((x) => [x.request.method, x.outcome, x.responseStatus, x.lglEntryId])), [
    [['POST', 'written', 200, '905'], ['PATCH', 'failed', 500, '11']],
  ])
  assert.match(vg.appends[0][1].note, /500/)
})

test('a POST that fails without a response is logged failed, with no status, and opens no lgl-incomplete hold', async () => {
  const timeout = new Error('LGL POST timed out')
  const lgl = fakeLgl({ answer: () => { throw timeout } })
  const vg = fakeVg()
  const e = await run([emailW()], { lgl, vg }).catch((x) => x)
  assert.equal(e, timeout)
  assert.deepEqual(sent(lgl).map((c) => c[0]), ['POST']) // never retried here
  assert.deepEqual(vg.appends[0].map((x) => [x.request.method, x.outcome, x.responseStatus, x.lglEntryId, x.note]), [
    ['POST', 'failed', null, null, 'LGL POST timed out'],
  ])
  assert.deepEqual(e.partial.holds, [])
})

test('a field whose calls stop part way opens an lgl-incomplete hold naming the entry left current', async () => {
  const lgl = fakeLgl({
    answer: (method, path, body) => {
      if (path === '/email_addresses/11') throw lglError(500)
      return method === 'POST' ? { id: 905, not_current: false } : { ...body }
    },
  })
  const vg = fakeVg()
  const e = await run([emailW({ personIds: ['7', '8'] })], { lgl, vg }).catch((x) => x)
  assert.match(e.message, /500/)
  assert.deepEqual(vg.appends[0].map((x) => [x.personId, x.request.method, x.outcome]), [
    ['7', 'POST', 'written'], ['8', 'POST', 'written'], ['7', 'PATCH', 'failed'], ['8', 'PATCH', 'failed'],
  ])
  const fp = fingerprint(['lgl-incomplete', 'email', 'new@example.org'])
  assert.deepEqual(e.partial.holds.map((h) => [h.lglConstituentId, h.personId, h.field, h.reason, h.fingerprint]), [
    ['101', '7', 'email', 'lgl-incomplete', fp], ['101', '8', 'email', 'lgl-incomplete', fp],
  ])
  assert.deepEqual(e.partial.holds[0].detail, {
    sent: [{ method: 'POST', path: '/constituents/101/email_addresses', body: { address: 'new@example.org', email_type_name: 'Home', is_preferred: true } }],
    failed: { method: 'PATCH', path: '/email_addresses/11', body: { not_current: true }, error: e.message },
    oldEntryId: '11',
    newEntryId: '905',
  })
  assert.deepEqual(e.partial.agree, [])
})

test('a failed run hands back what it gathered: memory and holds of the fields done', async () => {
  const records = { 101: con({ addressee: 'Mrs. J. Doe' }), 102: con({ id: 102 }) }
  const lgl = fakeLgl({
    records,
    answer: (method, path, body) => {
      if (path.startsWith('/constituents/102')) throw lglError(500)
      return method === 'POST' ? { id: 905, not_current: false } : { ...body }
    },
  })
  const w101 = nameW({ field: 'lastName', value: 'Roe', expect: comparable('lastName', 'Doe') })
  const e = await run([w101, emailW({ constituentId: '102', personIds: ['8'] })], { lgl }).catch((x) => x)
  assert.match(e.message, /500/)
  assert.deepEqual(e.partial.agree, [{ personId: '7', field: 'lastName', lglConstituentId: '101', value: 'Roe', lglEntryId: null }])
  assert.deepEqual(e.partial.holds.map((h) => [h.lglConstituentId, h.personId, h.reason]), [['101', '7', 'addressee']])
  assert.deepEqual(e.partial.counts, { written: 1, stale: 0, refused: 0 })
})

test('a failed log append on a failed run is named in the run\'s error', async () => {
  const lgl = fakeLgl({
    answer: (method, path, body) => {
      if (path === '/email_addresses/11') throw lglError(500)
      return method === 'POST' ? { id: 905, not_current: false } : { ...body }
    },
  })
  const vg = fakeVg({ appendErr: new Error('VG POST /sync/log → 503') })
  const e = await run([emailW({ personIds: ['7', '8'] })], { lgl, vg }).catch((x) => x)
  assert.match(e.message, /^LGL call → 500: invalid value; log append also failed: VG POST \/sync\/log → 503 — 2 call\(s\) sent but not logged$/)
  assert.equal(e.logError.message, 'VG POST /sync/log → 503')
})

test('two writes to the same constituent and field in one run are refused before anything is sent', async () => {
  const records = { 101: con(), 102: con({ id: 102 }) }
  const lgl = fakeLgl({ records })
  await assert.rejects(
    run([emailW({ constituentId: '102' }), emailW(), nameW(), emailW({ value: 'other@example.org', personIds: ['8'] })], { lgl }),
    /constituent 101.*two writes.*"email"/,
  )
  assert.ok(!lgl.calls.some((c) => c[1] === '101' || String(c[1]).includes('/101')))
})

test('an unclean value changed to another unclean value since the plan is stale', async () => {
  const planned = con({ email_addresses: [{ id: 11, address: 'not an email', is_preferred: true, not_current: false }] })
  const now = con({ email_addresses: [{ id: 11, address: 'still not an email', is_preferred: true, not_current: false }] })
  const w = emailW({ expect: lglExpect(lglFields(planned), 'email'), case: 'both-changed' })
  const lgl = fakeLgl({ records: { 101: now } })
  const { r } = await run([w], { lgl })
  assert.deepEqual(sent(lgl), [])
  assert.deepEqual(r.counts, { written: 0, stale: 1, refused: 0 })
})

test('phones: the clean slot edited while the other slot is unclean is stale', async () => {
  const phones = (home) => con({ phone_numbers: [
    { id: 31, number: home, phone_type_name: 'Home', is_preferred: true, not_current: false },
    { id: 32, number: '555-01', phone_type_name: 'Mobile', is_preferred: false, not_current: false },
  ] })
  const w = {
    kind: 'lgl', constituentId: '101', personIds: ['7'], field: 'phones', case: 'both-changed',
    value: { phone: '401-555-0199', cell: '401-555-0188' }, expect: lglExpect(lglFields(phones('401-555-0101')), 'phones'),
    fingerprint: 'x', merge: false, send: true,
  }
  const lgl = fakeLgl({ records: { 101: phones('401-555-0102') } })
  const { r } = await run([w], { lgl })
  assert.deepEqual(sent(lgl), [])
  assert.deepEqual(r.counts, { written: 0, stale: 1, refused: 0 })
})

test('every call sent is logged in one append per constituent, with LGL\'s old value', async () => {
  const { vg } = await run([emailW({ personIds: ['7', '8'] }), nameW({ personIds: ['7'] })])
  assert.equal(vg.appends.length, 1)
  const base = { runId: '42', lglConstituentId: '101', case: 'vg-changed', outcome: 'written', responseStatus: 200, note: null }
  assert.deepEqual(vg.appends[0], [
    { ...base, personId: '7', field: 'email', request: { method: 'POST', path: '/constituents/101/email_addresses', body: { address: 'new@example.org', email_type_name: 'Home', is_preferred: true } },
      lglEntryId: '900', oldValue: 'old@example.org', newValue: 'new@example.org' },
    { ...base, personId: '8', field: 'email', request: { method: 'POST', path: '/constituents/101/email_addresses', body: { address: 'new@example.org', email_type_name: 'Home', is_preferred: true } },
      lglEntryId: '900', oldValue: 'old@example.org', newValue: 'new@example.org' },
    { ...base, personId: '7', field: 'email', request: { method: 'PATCH', path: '/email_addresses/11', body: { not_current: true } },
      lglEntryId: '11', oldValue: 'old@example.org', newValue: 'new@example.org' },
    { ...base, personId: '8', field: 'email', request: { method: 'PATCH', path: '/email_addresses/11', body: { not_current: true } },
      lglEntryId: '11', oldValue: 'old@example.org', newValue: 'new@example.org' },
    { ...base, personId: '7', field: 'firstName', request: { method: 'PATCH', path: '/constituents/101', body: { first_name: 'Janet', addressee: '', salutation: '' } },
      lglEntryId: null, oldValue: 'Jane', newValue: 'Janet' },
  ])
})

test('an unclean LGL value is logged as LGL stored it', async () => {
  const record = con({ email_addresses: [{ id: 11, address: 'not an email', is_preferred: true, not_current: false }] })
  const { vg } = await run([emailW({ expect: lglExpect(lglFields(record), 'email'), case: 'both-changed' })], { lgl: fakeLgl({ records: { 101: record } }) })
  assert.deepEqual(vg.appends[0].map((x) => [x.oldValue, x.lglEntryId]), [['not an email', '900'], ['not an email', '11']])
})

test('a failed log append fails the run', async () => {
  const vg = fakeVg({ appendErr: new Error('VG POST /sync/log → 500') })
  const records = { 101: con(), 102: con({ id: 102 }) }
  const lgl = fakeLgl({ records })
  await assert.rejects(run([emailW(), emailW({ constituentId: '102' })], { lgl, vg }), /sync\/log/)
  assert.equal(vg.appends.length, 1) // never re-sent, and the next constituent is not started
  assert.ok(!lgl.calls.some((c) => c[0] === 'READ' && c[1] === '102'))
})

test('memory: one agreed row per person with VG\'s value and the entry id written', async () => {
  const address = { street: '1 Elm St', unit: null, city: 'Zzyzxford', state: 'RI', zip: '00901' }
  const addrW = {
    kind: 'lgl', constituentId: '101', personIds: ['7', '8'], field: 'address', case: 'vg-changed',
    value: address, expect: '', fingerprint: 'x', merge: false, send: true,
  }
  const { r } = await run([emailW({ personIds: ['7', '8'] }), addrW, nameW()])
  assert.deepEqual(r.agree, [
    { personId: '7', field: 'email', lglConstituentId: '101', value: 'new@example.org', lglEntryId: '900' },
    { personId: '8', field: 'email', lglConstituentId: '101', value: 'new@example.org', lglEntryId: '900' },
    { personId: '7', field: 'address', lglConstituentId: '101', value: address, lglEntryId: '901' },
    { personId: '8', field: 'address', lglConstituentId: '101', value: address, lglEntryId: '901' },
    { personId: '7', field: 'firstName', lglConstituentId: '101', value: 'Janet', lglEntryId: null },
  ])
})

test('a merge write records no memory row', async () => {
  const record = con({ phone_numbers: [{ id: 31, number: '(401) 555-0103', normalized_number: '4015550103', phone_type_name: 'Mobile', is_preferred: true, not_current: false }] })
  const w = {
    kind: 'lgl', constituentId: '101', personIds: ['7'], field: 'phones', case: 'never-agreed',
    value: { phone: '401-555-0102', cell: null }, expect: comparable('phones', { phone: null, cell: '401-555-0103' }),
    fingerprint: 'x', merge: true, send: true,
  }
  const { r, lgl } = await run([w], { lgl: fakeLgl({ records: { 101: record } }) })
  assert.deepEqual(sent(lgl), [['POST', '/constituents/101/phone_numbers', { number: '401-555-0102', phone_type_name: 'Home', is_preferred: false }]])
  assert.deepEqual(r.counts, { written: 1, stale: 0, refused: 0 })
  assert.deepEqual(r.agree, [])
})

test('a name written over a hand-written addressee opens an addressee hold, fingerprint the name written', async () => {
  const record = con({ addressee: 'Mrs. J. Doe' })
  const w = nameW({ field: 'lastName', value: 'Roe', expect: comparable('lastName', 'Doe'), personIds: ['7', '8'] })
  const { r, lgl } = await run([w], { lgl: fakeLgl({ records: { 101: record } }) })
  assert.deepEqual(sent(lgl), [['PATCH', '/constituents/101', { last_name: 'Roe' }]])
  const fp = fingerprint(['addressee', 'lastName', 'Roe'])
  assert.deepEqual(r.holds.map((h) => [h.lglConstituentId, h.personId, h.field, h.reason, h.fingerprint]), [
    ['101', '7', 'lastName', 'addressee', fp], ['101', '8', 'lastName', 'addressee', fp],
  ])
  assert.deepEqual(r.holds[0].detail, { addressee: 'Mrs. J. Doe', salutation: 'Jane', written: 'Roe' })
  assert.equal(r.counts.written, 1)
})

test('a default addressee is rebuilt and opens no hold; a refused name opens none either', async () => {
  const ok = await run([nameW()])
  assert.deepEqual(ok.r.holds, [])
  const lgl = fakeLgl({ records: { 101: con({ addressee: 'Mrs. J. Doe' }) }, answer: () => { throw lglError(422) } })
  const refused = await run([nameW()], { lgl })
  assert.deepEqual(refused.r.holds.map((h) => h.reason), ['lgl-refused'])
})

test('the addressee setting never leaves the envelope and opens no hold', async () => {
  const lgl = fakeLgl({ records: { 101: con({ addressee: 'Mrs. J. Doe' }) } })
  const { r } = await run([nameW()], { lgl, policy: { setting: () => 'never' } })
  assert.deepEqual(sent(lgl), [['PATCH', '/constituents/101', { first_name: 'Janet' }]])
  assert.deepEqual(r.holds, [])
})

test('stop between constituents finishes the one in hand', async () => {
  const ac = new AbortController()
  const records = { 101: con(), 102: con({ id: 102 }) }
  const lgl = fakeLgl({ records, onCall: () => ac.abort() })
  const { r, vg } = await run([emailW(), nameW(), emailW({ constituentId: '102' })], { lgl, signal: ac.signal })
  assert.equal(r.stopped, true)
  // 101's three calls all go and are logged; 102 is never read
  assert.deepEqual(sent(lgl).map((c) => c[1]), ['/constituents/101/email_addresses', '/email_addresses/11', '/constituents/101'])
  assert.ok(!lgl.calls.some((c) => c[0] === 'READ' && c[1] === '102'))
  assert.equal(vg.appends.length, 1)
  assert.equal(vg.appends[0].length, 3)
  assert.deepEqual(r.counts, { written: 2, stale: 0, refused: 0 })
})

test('an aborted signal sends nothing', async () => {
  const ac = new AbortController()
  ac.abort()
  const { r, lgl } = await run([emailW()], { signal: ac.signal })
  assert.equal(r.stopped, true)
  assert.deepEqual(lgl.calls, [])
})

test('lglAttempts reaches every LGL call', async () => {
  const seen = []
  const lgl = fakeLgl()
  for (const k of ['getConstituentFull', 'addEntry', 'patchEntry', 'patchConstituent']) {
    const f = lgl[k]
    lgl[k] = (...a) => { seen.push([k, a.at(-1)]); return f(...a) }
  }
  await run([emailW(), nameW()], { lgl, attempts: 1 })
  assert.deepEqual(seen.map((s) => s[0]), ['getConstituentFull', 'addEntry', 'patchEntry', 'patchConstituent'])
  assert.ok(seen.every((s) => s[1]?.attempts === 1))
})

test('a check read that fails after an add still logs the add before the run fails', async () => {
  const lgl = fakeLgl({ answer: (method, path, body) => (method === 'POST' ? { id: 905 } : { ...body }) })
  lgl.listEntries = async () => { throw lglError(500) }
  const vg = fakeVg()
  await assert.rejects(run([emailW()], { lgl, vg }), /500/)
  assert.deepEqual(sent(lgl).map((c) => c[0]), ['POST']) // no retire
  assert.deepEqual(vg.appends.map((rows) => rows.map((x) => [x.request.method, x.outcome, x.lglEntryId])), [[['POST', 'written', '905']]])
})

test('a 404 on a retire means the entry is already gone: the field is written', async () => {
  const lgl = fakeLgl({
    answer: (method, path, body) => {
      if (path === '/email_addresses/11') throw lglError(404)
      return method === 'POST' ? { id: 905, not_current: false } : { ...body }
    },
  })
  const { r, vg } = await run([emailW()], { lgl })
  assert.deepEqual(r.counts, { written: 1, stale: 0, refused: 0 })
  assert.deepEqual(r.holds, [])
  assert.deepEqual(r.agree.map((a) => [a.field, a.lglEntryId]), [['email', '905']])
  assert.deepEqual(vg.appends[0].map((x) => [x.request.method, x.outcome, x.responseStatus, x.note]), [
    ['POST', 'written', 200, null], ['PATCH', 'written', 404, 'already gone'],
  ])
})

test('a 404 on a revive means the entry is gone: the field is stale, with no hold', async () => {
  const record = con({ email_addresses: [
    { id: 11, address: 'old@example.org', is_preferred: true, not_current: false },
    { id: 13, address: 'new@example.org', is_preferred: false, not_current: true },
  ] })
  const lgl = fakeLgl({
    records: { 101: record },
    answer: (method, path, body) => { if (path === '/email_addresses/13') throw lglError(404); return { ...body } },
  })
  const { r, vg } = await run([emailW()], { lgl })
  assert.deepEqual(sent(lgl).map((c) => c[1]), ['/email_addresses/13']) // the old entry is not retired
  assert.deepEqual(r.counts, { written: 0, stale: 1, refused: 0 })
  assert.deepEqual(r.holds, [])
  assert.deepEqual(r.agree, [])
  assert.deepEqual(vg.appends[0].map((x) => [x.request.method, x.outcome, x.responseStatus, x.lglEntryId, x.note]), [
    ['PATCH', 'refused', 404, '13', 'entry gone'],
  ])
})

test('a retire refused after the add went through opens lgl-incomplete, not lgl-refused', async () => {
  const lgl = fakeLgl({
    answer: (method, path, body) => {
      if (path === '/email_addresses/11') throw lglError(422)
      return method === 'POST' ? { id: 905, not_current: false } : { ...body }
    },
  })
  const { r, vg } = await run([emailW()], { lgl })
  assert.deepEqual(r.counts, { written: 0, stale: 0, refused: 1 })
  assert.deepEqual(r.holds.map((h) => [h.field, h.reason, h.fingerprint]), [
    ['email', 'lgl-incomplete', fingerprint(['lgl-incomplete', 'email', 'new@example.org'])],
  ])
  assert.deepEqual(r.holds[0].detail.failed, { method: 'PATCH', path: '/email_addresses/11', body: { not_current: true }, error: 'LGL call → 422: invalid value' })
  assert.equal(r.holds[0].detail.oldEntryId, '11')
  assert.deepEqual(r.agree, [])
  assert.deepEqual(vg.appends[0].map((x) => [x.request.method, x.outcome]), [['POST', 'written'], ['PATCH', 'refused']])
})

test('an add answered without an entry id fails the run and opens lgl-incomplete; it is not a refusal', async () => {
  const lgl = fakeLgl({ answer: (method, path, body) => (method === 'POST' ? {} : { ...body }) })
  const vg = fakeVg()
  const e = await run([emailW()], { lgl, vg }).catch((x) => x)
  assert.match(e.message, /without an entry id/)
  assert.deepEqual(sent(lgl).map((c) => c[0]), ['POST'])
  assert.deepEqual(vg.appends[0].map((x) => [x.request.method, x.outcome]), [['POST', 'written']])
  assert.deepEqual(e.partial.holds.map((h) => h.reason), ['lgl-incomplete'])
  assert.equal(e.partial.counts.refused, 0)
})

test('a check read that fails after an add: the lgl-incomplete hold names the read, not the add', async () => {
  const lgl = fakeLgl({ answer: (method, path, body) => (method === 'POST' ? { id: 905 } : { ...body }) })
  lgl.listEntries = async () => { throw lglError(503) }
  const e = await run([emailW()], { lgl }).catch((x) => x)
  assert.equal(e.partial.holds.length, 1)
  assert.deepEqual(e.partial.holds[0].detail.failed, { method: 'GET', path: '/constituents/101/email_addresses', body: null, error: 'LGL call → 503: invalid value' })
  assert.deepEqual(e.partial.holds[0].detail.sent.map((c) => c.method), ['POST'])
})

// Phones: a home and a cell, both changed in VG. Calls: add home, retire 21, add cell, retire 22.
const phonesRecord = () => con({
  email_addresses: [],
  phone_numbers: [
    { id: 21, number: '401-555-0101', normalized_number: '4015550101', phone_type_name: 'Home', is_preferred: true, not_current: false },
    { id: 22, number: '401-555-0102', normalized_number: '4015550102', phone_type_name: 'Mobile', is_preferred: false, not_current: false },
  ],
})
const phonesW = () => {
  const read = lglFields(phonesRecord())
  return {
    kind: 'lgl', constituentId: '101', personIds: ['7'], field: 'phones', case: 'vg-changed',
    value: { phone: '401-555-0201', cell: '401-555-0202' }, expect: lglExpect(read, 'phones'),
    fingerprint: fingerprint(['phones', 'x']), merge: false, send: true,
  }
}
const phonesLgl = (fail) => {
  let n = 900
  return fakeLgl({
    records: { 101: phonesRecord() },
    answer: (method, path, body) => {
      const f = fail(method, path, body)
      if (f) throw f
      return method === 'POST' ? { id: ++n, not_current: false, ...body } : { ...body }
    },
  })
}
const isCellAdd = (method, path, body) => method === 'POST' && body.phone_type_name === 'Mobile'

test('phones: the cell add fails after the home number is done: no lgl-incomplete hold (the next run sends the cell)', async () => {
  const lgl = phonesLgl((m, p, b) => (isCellAdd(m, p, b) ? lglError(500) : null))
  const e = await run([phonesW()], { lgl }).catch((x) => x)
  assert.match(e.message, /500/)
  assert.deepEqual(sent(lgl).map((c) => [c[0], c[1]]), [
    ['POST', '/constituents/101/phone_numbers'], ['PATCH', '/phone_numbers/21'], ['POST', '/constituents/101/phone_numbers'],
  ])
  assert.deepEqual(e.partial.holds, [])
})

test('phones: the cell add refused after the home number is done: lgl-refused, not lgl-incomplete', async () => {
  const lgl = phonesLgl((m, p, b) => (isCellAdd(m, p, b) ? lglError(422) : null))
  const { r } = await run([phonesW()], { lgl })
  assert.deepEqual(r.holds.map((h) => h.reason), ['lgl-refused'])
  assert.deepEqual(r.counts, { written: 0, stale: 0, refused: 1 })
})

test('phones: the cell retire fails after the cell add: lgl-incomplete names the old cell and the new one', async () => {
  const lgl = phonesLgl((m, p) => (m === 'PATCH' && p === '/phone_numbers/22' ? lglError(500) : null))
  const e = await run([phonesW()], { lgl }).catch((x) => x)
  assert.deepEqual(e.partial.holds.map((h) => h.reason), ['lgl-incomplete'])
  const d = e.partial.holds[0].detail
  assert.equal(d.oldEntryId, '22')
  assert.equal(d.newEntryId, '902')
  assert.deepEqual(d.failed.path, '/phone_numbers/22')
  assert.deepEqual(d.sent.map((c) => c.method), ['POST', 'PATCH', 'POST'])
})

test('phones: the home retire refused after the home add: lgl-incomplete names the old home entry, and the cell is not sent', async () => {
  const lgl = phonesLgl((m, p) => (m === 'PATCH' && p === '/phone_numbers/21' ? lglError(422) : null))
  const { r } = await run([phonesW()], { lgl })
  assert.deepEqual(r.holds.map((h) => [h.reason, h.detail.oldEntryId, h.detail.newEntryId]), [['lgl-incomplete', '21', '901']])
  assert.deepEqual(sent(lgl).map((c) => c[0]), ['POST', 'PATCH'])
})
