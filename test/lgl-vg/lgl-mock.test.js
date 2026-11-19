import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLglClient } from '../../src/lgl-vg/lgl.js'
import { createMockLglFetch, openLgl } from '../../src/lgl-vg/lgl-mock.js'

const T0 = '2026-11-01T00:00:00Z'
const state = () => ({
  pulledAt: T0,
  constituents: [
    {
      id: 101, first_name: 'Jane', last_name: 'Doe', suffix: null, prefix: null, nick_name: null,
      addressee: 'Jane Doe', salutation: 'Jane', updated_at: T0,
      street_addresses: [{ id: 12, street: '12 Elm St', city: 'Zzyzxford', state: 'RI', postal_code: '00901', is_preferred: true, not_current: false }],
      email_addresses: [{ id: 11, address: 'jane@example.org', is_preferred: true, not_current: false }],
      phone_numbers: [{ id: 13, number: '401-555-0101', normalized_number: '4015550101', phone_type_name: 'Home', is_preferred: true, not_current: false }],
    },
    { id: 102, first_name: 'John', last_name: 'Roe', updated_at: T0, street_addresses: [], email_addresses: [], phone_numbers: [] },
  ],
  gifts: [{ id: 1, constituent_id: 101, received_date: '2026-01-05', updated_at: T0 }],
})

// A client over the mock, a clock that moves on, and the saved states.
function setup (s = state()) {
  let t = Date.parse('2026-11-19T12:00:00Z')
  const saved = []
  const fetchImpl = createMockLglFetch({ state: s, persist: async (x) => { saved.push(JSON.parse(JSON.stringify(x))) }, now: () => (t += 1000) })
  const lgl = createLglClient({ apiKey: 'mock', fetchImpl, sleep: async () => {} })
  return { lgl, saved, s }
}

test('reads answer from the state, in the API\'s shapes', async () => {
  const { lgl } = setup()
  assert.deepEqual((await lgl.pullConstituents()).map((c) => c.id), [101, 102])
  assert.equal((await lgl.pullGifts()).length, 1)
  assert.equal((await lgl.getConstituent(101)).last_name, 'Doe')
  assert.deepEqual((await lgl.constituentGifts(101)).map((g) => g.id), [1])
  assert.deepEqual((await lgl.constituentGifts(102)), [])
  assert.deepEqual((await lgl.listEntries(101, 'phone_numbers')).map((e) => e.id), [13])
  const full = await lgl.getConstituentFull(101)
  assert.deepEqual([full.street_addresses.length, full.email_addresses.length, full.phone_numbers.length], [1, 1, 1])
  assert.deepEqual(await lgl.probe(), { rateLimited: false })
})

test('an unknown constituent or entry answers 404', async () => {
  const { lgl } = setup()
  await assert.rejects(lgl.getConstituent(999), (e) => e.status === 404)
  await assert.rejects(lgl.patchEntry('phone_numbers', 999, { not_current: true }), (e) => e.status === 404)
  await assert.rejects(lgl.patchConstituent(999, { first_name: 'X' }), (e) => e.status === 404)
})

test('patchConstituent changes the record, stamps updated_at and saves the state', async () => {
  const { lgl, saved } = setup()
  const r = await lgl.patchConstituent(101, { nick_name: 'Janie' })
  assert.equal(r.nick_name, 'Janie')
  assert.ok(Date.parse(r.updated_at) > Date.parse(T0))
  assert.equal(saved.length, 1)
  assert.equal(saved[0].constituents[0].nick_name, 'Janie')
})

test('an empty addressee and salutation are rebuilt from the new name, as LGL does', async () => {
  const { lgl } = setup()
  const r = await lgl.patchConstituent(101, { first_name: 'Janet', addressee: '', salutation: '' })
  assert.deepEqual([r.addressee, r.salutation], ['Janet Doe', 'Janet'])
})

test('addEntry gives a new id, normalizes a phone, and a preferred entry takes the mark from its kind', async () => {
  const { lgl } = setup()
  const e = await lgl.addEntry(101, 'phone_numbers', { number: '(401) 555-0150', phone_type_name: 'Mobile', is_preferred: true })
  assert.ok(e.id > 13)
  assert.deepEqual([e.normalized_number, e.not_current, e.is_preferred], ['4015550150', false, true])
  const list = await lgl.listEntries(101, 'phone_numbers')
  assert.deepEqual(list.map((x) => [x.id, x.is_preferred]), [[13, false], [e.id, true]])
  // ids are unique across every kind
  const a = await lgl.addEntry(101, 'email_addresses', { address: 'jd@example.org', email_type_name: 'Home' })
  assert.ok(a.id > e.id)
  assert.equal(a.is_preferred, false)
})

test('the first entry of a kind is preferred', async () => {
  const { lgl } = setup()
  const e = await lgl.addEntry(102, 'street_addresses', { street: '4 Oak Rd', city: 'Zzyzxford', state: 'RI', postal_code: '00901' })
  assert.equal(e.is_preferred, true)
  assert.equal(e.zip5, '00901')
})

test('patchEntry retires, revives and moves the mark; it stamps the constituent', async () => {
  const { lgl } = setup()
  const r = await lgl.patchEntry('street_addresses', 12, { not_current: true })
  assert.equal(r.not_current, true)
  const c = await lgl.getConstituent(101)
  assert.ok(Date.parse(c.updated_at) > Date.parse(T0))
  assert.equal(c.street_addresses[0].not_current, true)
})

test('a write is read back by the next pull and by constituentsSince; untouched records are not', async () => {
  const { lgl } = setup()
  const before = new Date(Date.parse('2026-11-19T12:00:00Z')).toISOString()
  await lgl.addEntry(101, 'phone_numbers', { number: '401-555-0150', phone_type_name: 'Mobile' })
  const pulled = await lgl.pullConstituents()
  assert.deepEqual(pulled.find((c) => c.id === 101).phone_numbers.map((p) => p.normalized_number), ['4015550101', '4015550150'])
  assert.deepEqual((await lgl.constituentsSince(before)).map((c) => c.id), [101])
  assert.deepEqual((await lgl.giftsSince('2026-11-19')), [])
  assert.deepEqual((await lgl.giftsSince('2026-10-01')).map((g) => g.id), [1])
})

test('an unknown route answers 404 and never reaches the network', async () => {
  const fetchImpl = createMockLglFetch({ state: state(), persist: async () => {}, now: () => 0 })
  const res = await fetchImpl('https://api.littlegreenlight.com/api/v1/funds.json', { method: 'GET' })
  assert.equal(res.status, 404)
  await assert.rejects(fetchImpl('https://example.org/x', { method: 'GET' }), /mock LGL/)
})

test('openLgl: with LGL_MOCK the client reads the state file and writes it back; without it, the real client', async () => {
  const files = { 'out/mock.json': JSON.stringify(state()) }
  const deps = { readFile: async (p) => { if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files[p] }, writeFile: async (p, t) => { files[p] = t }, now: () => Date.parse('2026-11-19T12:00:00Z'), sleep: async () => {}, fetchImpl: async () => { throw new Error('network') } }
  const { lgl, mock } = await openLgl({ lgl: { apiKey: '', mock: 'out/mock.json' } }, deps)
  assert.equal(mock, 'out/mock.json')
  await lgl.patchConstituent(102, { nick_name: 'Jack' })
  assert.equal(JSON.parse(files['out/mock.json']).constituents[1].nick_name, 'Jack')
  await assert.rejects(openLgl({ lgl: { apiKey: '', mock: 'out/none.json' } }, deps), /LGL_MOCK.*out\/none.json/)
  const real = await openLgl({ lgl: { apiKey: 'k', mock: null } }, deps)
  assert.equal(real.mock, null)
  await assert.rejects(real.lgl.probe(), /network/)
})
