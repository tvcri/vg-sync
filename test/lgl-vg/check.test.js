import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runCheck } from '../../src/lgl-vg/check.js'
import { parsePolicy } from '../../src/lgl-vg/policy.js'
import { FIELDS, lglFields } from '../../src/lgl-vg/fields.js'

const policy = parsePolicy(readFileSync(new URL('../../policy.json', import.meta.url), 'utf8'))
const NOW = Date.parse('2026-11-15T10:00:00.000Z')
const config = {
  lgl: { membershipFundId: 5, paypalPaymentTypeId: 2 }, createHorizonYears: 5,
  circuitBreakerPeople: 50, imageRevision: 'abc123', passTimeoutMinutes: 30, checkTimeoutMinutes: 5,
}

const con = (id, o = {}) => ({
  id, first_name: 'Jane', last_name: 'Doe', nick_name: null, suffix: null,
  is_deceased: false, deceased_date: null, is_org: false,
  email_addresses: [{ id: id * 10 + 1, address: `jane${id}@example.org`, is_preferred: true }],
  street_addresses: [{ id: id * 10 + 2, street: `${id} Elm St`, city: 'Springfield', state: 'RI', zip5: '99999', is_preferred: true }],
  phone_numbers: [],
  updated_at: '2026-11-15T08:00:00Z',
  ...o,
})
const linkTo = (cid, lastGiftDate = '2026-06-01') => ({ lglConstituentId: String(cid), lastGiftDate })
// a VG person whose detail matches con(cid)
const per = (personId, cid, { donor = linkTo(cid), ...detail } = {}) => ({
  personId: String(personId), deceased: false, email: `jane${cid}@example.org`, phone: { phone: null, cell: null }, donor,
  detail: {
    firstName: 'Jane', lastName: 'Doe', suffix: null, nickname: null,
    street: `${cid} Elm St`, unit: null, city: 'Springfield', state: 'RI', zip: '99999', deceasedDate: null, ...detail,
  },
})
const gift = (cid, date = '2026-06-01', id = cid * 100) => ({ id, constituent_id: cid, received_date: date, gift_type_id: 1, fund_id: 9, payment_type_id: 1 })
const agreedAt = (c, personId) => FIELDS.map((field) => ({
  personId: String(personId), field, lglConstituentId: String(c.id), value: lglFields(c).values[field], lglEntryId: null, agreedAt: '2026-11-01T00:00:00Z',
}))
const cacheOf = (constituents, gifts = constituents.map((c) => gift(c.id))) => ({
  constituents: new Map(constituents.map((c) => [String(c.id), c])),
  gifts: new Map(gifts.map((g) => [String(g.id), g])),
})
const notFound = () => Object.assign(new Error('LGL GET /constituents/x.json → 404: not found'), { status: 404 })

function fakes({
  persons = [], memory = [], holds = [], runs = [], feed = [{ lastAuditId: 5, more: false, persons: [] }],
  lglRecords = {}, since = { constituents: [], gifts: [] }, vgOverrides = {}, lglOverrides = {},
} = {}) {
  const calls = []
  const rec = (name, ret) => async (...a) => { calls.push([name, ...a]); return typeof ret === 'function' ? ret(...a) : ret }
  let page = 0
  const vg = {
    getChanges: rec('getChanges', () => feed[page++]),
    listPersons: rec('listPersons', persons),
    getSyncFieldsFor: rec('getSyncFieldsFor', (ids) => memory.filter((m) => ids.includes(m.personId))),
    getSyncHolds: rec('getSyncHolds', holds),
    // as VG answers: kind and since (on startedAt) filter the rows
    recentRuns: rec('recentRuns', (arg = {}) => runs.filter((r) =>
      (!arg.kinds?.length || arg.kinds.includes(r.kind)) && (!arg.since || !(Date.parse(r.startedAt) < Date.parse(arg.since))))),
    startRun: rec('startRun', { runId: 9 }),
    finishRun: rec('finishRun', {}),
    getLinkedPersons: rec('getLinkedPersons', (cid) => persons.filter((p) => p.donor?.lglConstituentId === String(cid))),
    geocodeTown: rec('geocodeTown', { town: 'Springfield' }),
    patchPerson: rec('patchPerson', {}),
    putDonor: rec('putDonor', {}),
    putSyncFields: rec('putSyncFields', 1),
    createSyncHolds: rec('createSyncHolds', []),
    patchSyncHolds: rec('patchSyncHolds', 1),
    apiState: rec('apiState', { currentState: 'available', since: '2026-11-15T00:00:00.000Z', dependencies: { db: true, oidc: true } }),
    getSyncLog: rec('getSyncLog', []),
    appendSyncLog: rec('appendSyncLog', (rows) => rows.length),
    ...vgOverrides,
  }
  // LGL writes are sent only with writeLgl, to allowed constituents
  const lgl = {
    getConstituentFull: rec('getConstituentFull', (id) => {
      const r = lglRecords[String(id)]
      if (r === 404 || !r) throw notFound()
      return structuredClone(r)
    }),
    addEntry: rec('addEntry', (id, kind, body) => ({ id: 900, not_current: false, ...body })),
    patchEntry: rec('patchEntry', (kind, entryId, body) => ({ ...body })),
    patchConstituent: rec('patchConstituent', (id, body) => ({ ...body })),
    listEntries: rec('listEntries', []),
    getConstituent: rec('getConstituent', (id) => {
      const r = lglRecords[String(id)]
      if (r === 404) throw notFound()
      return r
    }),
    constituentGifts: rec('constituentGifts', []),
    constituentsSince: rec('constituentsSince', since.constituents),
    giftsSince: rec('giftsSince', since.gifts),
    ...lglOverrides,
  }
  const out = []
  const files = []
  const args = (extra = {}) => ({
    kind: 'vg-check', state: { cache: cacheOf([]), lglCursor: '2026-11-15T09:00:00.000Z', vgCursor: 5 },
    config, policy, vg, lgl, writeVg: false, now: () => NOW,
    writeLines: async (p, t, opts) => files.push({ path: p, text: t, opts }), stdout: (t) => out.push(t), out: 'out',
    ...extra,
  })
  const names = () => calls.map((c) => c[0])
  return { vg, lgl, calls, out, files, args, names }
}

const WRITES = ['startRun', 'patchPerson', 'putSyncFields', 'putDonor', 'createSyncHolds', 'patchSyncHolds', 'finishRun']
const LGL_WRITES = ['addEntry', 'patchEntry', 'patchConstituent', 'appendSyncLog']
const feedOf = (...personIds) => [{ lastAuditId: 12, more: false, persons: personIds.map((id) => ({ personId: String(id), changes: [] })) }]
const lines = (file) => file.text.trim().split('\n').map((l) => JSON.parse(l))

test('a quiet vg check advances the cursor and prints nothing', async () => {
  const f = fakes({
    persons: [per(8, 101, { donor: null })],
    feed: [
      { lastAuditId: 8, more: true, persons: [{ personId: '8', changes: [] }] },
      { lastAuditId: 12, more: false, persons: [] },
    ],
  })
  const a = f.args()
  const r = await runCheck(a)
  assert.deepEqual(r, { outcome: 'ok', final: false, breaker: false, rateLimited: false, foundChange: false, error: null })
  assert.deepEqual(f.calls.filter((c) => c[0] === 'getChanges').map((c) => c[1]), [5, 8])
  assert.equal(a.state.vgCursor, 12)
  assert.deepEqual([f.out, f.files], [[], []])
  for (const n of [...WRITES, 'getConstituent', 'getSyncHolds']) assert.ok(!f.names().includes(n), n)
})

test('an empty feed reads nothing else', async () => {
  const f = fakes({ feed: [{ lastAuditId: 5, more: false, persons: [] }] })
  const a = f.args()
  assert.equal((await runCheck(a)).outcome, 'ok')
  assert.deepEqual(f.names(), ['getChanges'])
  assert.equal(a.state.vgCursor, 5)
})

test('a vg edit plans to-lgl as deferred and writes nothing to LGL', async () => {
  const c = con(101)
  const f = fakes({
    persons: [per(7, 101, { firstName: 'Janet' })], memory: agreedAt(c, 7), feed: feedOf(7), lglRecords: { 101: c },
  })
  const a = f.args({ writeVg: true, state: { cache: cacheOf([c]), lglCursor: '2026-11-15T09:00:00.000Z', vgCursor: 5 } })
  const r = await runCheck(a)
  assert.equal(r.outcome, 'ok')
  assert.equal(r.foundChange, true)
  assert.deepEqual(f.calls.find((x) => x[0] === 'getConstituent').slice(1), ['101', { attempts: 1 }])
  assert.ok(!f.names().includes('patchPerson'))
  assert.deepEqual(f.calls.find((x) => x[0] === 'startRun')[1], {
    kind: 'vg-check', switches: { writeVg: true, writeLgl: false }, imageRevision: 'abc123', policyHash: policy.hash,
  })
  const fin = f.calls.find((x) => x[0] === 'finishRun')[2]
  assert.equal(fin.result, 'ok')
  assert.deepEqual([fin.counts.peopleChanged, fin.counts.breakerPeople], [0, 0])
  assert.deepEqual([fin.vgCursor, fin.lglCursor], [12, '2026-11-15T09:00:00.000Z'])
  assert.equal(f.files.length, 1)
  assert.equal(f.files[0].path, 'out/checks-2026-11-15.jsonl')
  assert.deepEqual(f.files[0].opts, { append: true })
  const ds = lines(f.files[0])
  assert.ok(ds.some((d) => d.outcome === 'deferred' && d.field === 'firstName'))
  assert.ok(ds.every((d) => d.check === 'vg-check' && d.at === '2026-11-15T10:00:00.000Z'))
  assert.equal(f.out.at(-1), 'CHECK OK vg-check write-vg people=0 writes=0 deferred=1 links=0 creates=0 holdsOpened=0 holdsClosed=0 lgl-writes=0 lgl-stale=0 lgl-refused=0')
  assert.ok(f.out.some((l) => l.startsWith('{')), 'counts block when not quiet')
  assert.equal(a.state.vgCursor, 12)
})

test('a quiet check prints only the CHECK OK line', async () => {
  const c = con(101)
  const f = fakes({ persons: [per(7, 101, { firstName: 'Janet' })], memory: agreedAt(c, 7), feed: feedOf(7), lglRecords: { 101: c } })
  await runCheck(f.args({ quiet: true, state: { cache: cacheOf([c]), lglCursor: null, vgCursor: 5 } }))
  assert.deepEqual(f.out, ['CHECK OK vg-check dry-run people=0 writes=0 deferred=1 links=0 creates=0 holdsOpened=0 holdsClosed=0 lgl-writes=0 lgl-stale=0 lgl-refused=0'])
  for (const n of WRITES) assert.ok(!f.names().includes(n), n)
})

test('a 404 constituent is left to the full pass', async () => {
  const gone = con(101)
  const old = con(102)
  const renamed = con(102, { first_name: 'Janet' })
  const f = fakes({
    persons: [per(7, 101), per(8, 102)],
    memory: [...agreedAt(gone, 7), ...agreedAt(old, 8)],
    feed: feedOf(7, 8),
    lglRecords: { 101: 404, 102: renamed },
    holds: [],
  })
  const a = f.args({ state: { cache: cacheOf([gone, old]), lglCursor: null, vgCursor: 5 } })
  const r = await runCheck(a)
  assert.equal(r.outcome, 'ok')
  const ds = lines(f.files[0])
  assert.ok(ds.length > 0)
  assert.ok(ds.every((d) => d.constituentId === '102'), JSON.stringify(ds))
  assert.ok(ds.some((d) => d.outcome === 'write-vg' && d.field === 'firstName'))
  assert.match(f.out.at(-1), /^CHECK OK vg-check dry-run people=1 writes=1 /)
  assert.equal(a.state.vgCursor, 12)
  assert.equal(a.state.cache.constituents.get('102').first_name, 'Janet')
  assert.equal(a.state.cache.constituents.get('101'), gone)
})

test('a 404 constituent opens no hold and unlinks nobody when written', async () => {
  const gone = con(101)
  const f = fakes({ persons: [per(7, 101)], memory: agreedAt(gone, 7), feed: feedOf(7), lglRecords: { 101: 404 } })
  const a = f.args({ writeVg: true, state: { cache: cacheOf([gone]), lglCursor: null, vgCursor: 5 } })
  const r = await runCheck(a)
  assert.equal(r.outcome, 'ok')
  assert.equal(r.foundChange, false)
  for (const n of [...WRITES, 'deleteDonor']) assert.ok(!f.names().includes(n), n)
  assert.equal(a.state.vgCursor, 12)
})

test('more than 20 touched uses the cache and makes no LGL read', async () => {
  const cs = Array.from({ length: 21 }, (_, i) => con(101 + i))
  const persons = cs.map((c, i) => per(7 + i, c.id))
  const cache = cacheOf(cs.map((c, i) => (i === 0 ? { ...c, first_name: 'Janet' } : c)))
  const f = fakes({ persons, memory: cs.flatMap((c, i) => agreedAt(c, 7 + i)), feed: feedOf(...persons.map((p) => p.personId)) })
  const a = f.args({ lglPaused: true, state: { cache, lglCursor: null, vgCursor: 5 } })
  const r = await runCheck(a)
  assert.equal(r.outcome, 'ok')
  assert.ok(!f.names().includes('getConstituent'))
  assert.match(f.out.at(-1), /^CHECK OK vg-check dry-run people=1 writes=1 /)
  assert.equal(a.state.vgCursor, 12)
})

test('lglPaused fails a vg check that needs LGL reads, cursor unchanged', async () => {
  const c = con(101)
  const f = fakes({ persons: [per(7, 101)], memory: agreedAt(c, 7), feed: feedOf(7), lglRecords: { 101: c } })
  const a = f.args({ lglPaused: true })
  const r = await runCheck(a)
  assert.deepEqual(r, { outcome: 'failed', final: false, breaker: false, rateLimited: false, foundChange: false, error: 'LGL rate-limited' })
  assert.ok(!f.names().includes('getConstituent'))
  assert.equal(a.state.vgCursor, 5)
  assert.deepEqual([f.out, f.files], [[], []])
})

test('a 429 from LGL is rateLimited', async () => {
  const f = fakes({
    persons: [per(7, 101)], feed: feedOf(7),
    lglOverrides: { getConstituent: async () => { throw Object.assign(new Error('LGL GET /constituents/101.json → 429: slow down'), { status: 429 }) } },
  })
  const a = f.args()
  const r = await runCheck(a)
  assert.deepEqual([r.outcome, r.rateLimited, r.final], ['failed', true, false])
  assert.ok(!f.names().includes('apiState'))
  assert.equal(a.state.vgCursor, 5)
})

test('fetchGifts reads gifts for a constituent the cache has none for', async () => {
  const c = con(101)
  const fetched = []
  const f = fakes({ persons: [per(7, 101, { donor: linkTo(101, '2026-01-05') })], memory: agreedAt(c, 7), feed: feedOf(7), lglRecords: { 101: c } })
  const a = f.args({
    state: { cache: cacheOf([c], []), lglCursor: null, vgCursor: 5 },
    fetchGifts: async (id) => { fetched.push(id); return [gift(101)] },
  })
  const r = await runCheck(a)
  assert.equal(r.outcome, 'ok')
  assert.deepEqual(fetched, ['101'])
  assert.equal(a.state.cache.gifts.size, 1)
  assert.match(f.out.at(-1), /^CHECK OK vg-check dry-run people=1 writes=1 /)
})

test('an lgl check links a new donor who matches a VG person', async () => {
  const c = con(201, { updated_at: '2026-11-15T09:30:00Z' })
  const persons = [per(8, 201, { donor: null })]
  const f = fakes({ persons, since: { constituents: [c], gifts: [gift(201, '2026-11-14')] } })
  const cache = cacheOf([])
  const a = f.args({ kind: 'lgl-check', writeVg: true, state: { cache, lglCursor: '2026-11-15T09:00:00.000Z', vgCursor: 5 } })
  const r = await runCheck(a)
  assert.equal(r.outcome, 'ok', r.error)
  assert.equal(r.foundChange, true)
  assert.deepEqual(f.calls.find((x) => x[0] === 'constituentsSince').slice(1), ['2026-11-15T08:58:00.000Z', { attempts: 1 }])
  assert.deepEqual(f.calls.find((x) => x[0] === 'giftsSince').slice(1), ['2026-11-14', { attempts: 1 }])
  assert.ok(!f.names().includes('getChanges'))
  assert.deepEqual(f.calls.find((x) => x[0] === 'putDonor').slice(1), ['8', { lglConstituentId: '201', lastGiftDate: '2026-11-14' }])
  const fin = f.calls.find((x) => x[0] === 'finishRun')[2]
  assert.deepEqual([fin.lglCursor, fin.vgCursor, fin.counts.breakerPeople], ['2026-11-15T09:30:00Z', 5, 1])
  assert.equal(f.out.at(-1), 'CHECK OK lgl-check write-vg people=1 writes=0 deferred=0 links=1 creates=0 holdsOpened=0 holdsClosed=0 lgl-writes=0 lgl-stale=0 lgl-refused=0')
  assert.ok(lines(f.files[0]).every((d) => d.check === 'lgl-check'))
  assert.equal(a.state.lglCursor, '2026-11-15T09:30:00Z')
  assert.equal(a.state.cache.constituents.get('201'), c)
  assert.equal(cache.constituents.size, 0, 'the cache given is replaced, not changed')
})

test('a quiet lgl check updates the cursor and cache and prints nothing', async () => {
  const c = con(201)
  const f = fakes({ since: { constituents: [], gifts: [gift(201)] } })
  const a = f.args({ kind: 'lgl-check', state: { cache: cacheOf([c]), lglCursor: '2026-11-15T09:00:00.000Z', vgCursor: 5 } })
  const r = await runCheck(a)
  assert.equal(r.outcome, 'ok')
  assert.deepEqual(f.names(), ['constituentsSince', 'giftsSince'])
  assert.deepEqual([f.out, f.files], [[], []])
})

test('a second lgl check over an unchanged constituent with a deferred field is quiet', async () => {
  // The search asks from two minutes before the cursor, so the newest constituent comes back again.
  const before = con(201, { updated_at: '2026-11-15T08:00:00Z' })
  const c = con(201, { updated_at: '2026-11-15T09:30:00Z' })
  const f = fakes({ persons: [per(8, 201, { firstName: 'Janet' })], memory: agreedAt(c, 8), since: { constituents: [c], gifts: [gift(201)] } })
  const a = f.args({ kind: 'lgl-check', state: { cache: cacheOf([before]), lglCursor: '2026-11-15T09:00:00.000Z', vgCursor: 5 } })
  const first = await runCheck(a)
  assert.equal(first.outcome, 'ok', first.error)
  assert.equal(first.foundChange, true)
  assert.match(f.out.at(-1), /^CHECK OK lgl-check dry-run people=0 writes=0 deferred=1 /)
  const printed = f.out.length
  const second = await runCheck(a)
  assert.deepEqual(second, { outcome: 'ok', final: false, breaker: false, rateLimited: false, foundChange: false, error: null })
  assert.equal(f.out.length, printed, 'no CHECK OK line')
  assert.equal(f.files.length, 1, 'no second decisions file entry')
  assert.equal(a.state.lglCursor, '2026-11-15T09:30:00Z')
})

test('a failed lgl check leaves the cache and cursor unchanged', async () => {
  const c = con(201, { updated_at: '2026-11-15T09:30:00Z' })
  const f = fakes({
    since: { constituents: [c], gifts: [gift(201, '2026-11-14')] },
    vgOverrides: { listPersons: async () => { throw Object.assign(new Error('VG GET /persons → 500: oops'), { status: 500 }) } },
  })
  const cache = cacheOf([])
  const a = f.args({ kind: 'lgl-check', state: { cache, lglCursor: '2026-11-15T09:00:00.000Z', vgCursor: 5 } })
  const r = await runCheck(a)
  assert.equal(r.outcome, 'failed')
  assert.match(r.error, /^VG GET \/persons → 500: oops \(VG API available since/)
  assert.equal(a.state.cache, cache)
  assert.deepEqual([cache.constituents.size, cache.gifts.size], [0, 0])
  assert.equal(a.state.lglCursor, '2026-11-15T09:00:00.000Z')
  assert.deepEqual([f.out, f.files], [[], []])
})

const recentRunsArg = { kinds: ['vg-check', 'lgl-check'], since: '2026-11-14T10:00:00.000Z', limit: 1000 }

test('the breaker counts ok check runs of the last 24 hours and trips without writing', async () => {
  const c = con(101)
  const runs = [
    { runId: 1, kind: 'vg-check', result: 'ok', startedAt: '2026-11-15T09:00:00.000Z', counts: { breakerPeople: 30, peopleChanged: 90 } },
    { runId: 2, kind: 'lgl-check', result: 'ok', startedAt: '2026-11-14T12:00:00.000Z', counts: { breakerPeople: 20 } },
    { runId: 3, kind: 'lgl-check', result: 'failed', startedAt: '2026-11-15T09:10:00.000Z', counts: { breakerPeople: 40 } },
    { runId: 4, kind: 'vg-check', result: 'ok', startedAt: '2026-11-14T09:00:00.000Z', counts: { breakerPeople: 40 } }, // over 24 hours ago
  ]
  const setup = () => fakes({ persons: [per(7, 101)], memory: agreedAt(c, 7), feed: feedOf(7), lglRecords: { 101: con(101, { first_name: 'Janet' }) }, runs })
  const f = setup()
  const a = f.args({ writeVg: true, state: { cache: cacheOf([c]), lglCursor: null, vgCursor: 5 } })
  const r = await runCheck(a)
  assert.deepEqual(r, {
    outcome: 'failed', final: false, breaker: true, rateLimited: false, foundChange: true,
    error: 'circuit breaker: 51 people changed by checks in 24 hours, more than the limit of 50',
  })
  assert.deepEqual(f.calls.filter((x) => x[0] === 'recentRuns').map((x) => x[1]), [{ kinds: ['full'], limit: 20 }, recentRunsArg])
  for (const n of WRITES) assert.ok(!f.names().includes(n), n)
  assert.equal(a.state.vgCursor, 5)
  assert.deepEqual(f.out, [])

  // a dry run says so and goes on
  const d = setup()
  const b = d.args({ state: { cache: cacheOf([c]), lglCursor: null, vgCursor: 5 } })
  assert.equal((await runCheck(b)).outcome, 'ok')
  assert.match(d.out.at(-1), /^CHECK OK vg-check dry-run people=1 .* breaker=would-trip lgl-writes=0 lgl-stale=0 lgl-refused=0$/)
  assert.equal(b.state.vgCursor, 12)
})

test('a breaker count that reaches the read limit trips it, fail safe', async () => {
  const c = con(101)
  const runs = Array.from({ length: 1000 }, (_, i) => ({ runId: i + 1, kind: 'vg-check', result: 'ok', startedAt: '2026-11-15T09:00:00.000Z', counts: { breakerPeople: 0 } }))
  const setup = () => fakes({ persons: [per(7, 101)], memory: agreedAt(c, 7), feed: feedOf(7), lglRecords: { 101: con(101, { first_name: 'Janet' }) }, runs })
  const f = setup()
  const a = f.args({ writeVg: true, state: { cache: cacheOf([c]), lglCursor: null, vgCursor: 5 } })
  const r = await runCheck(a)
  assert.deepEqual(r, {
    outcome: 'failed', final: false, breaker: true, rateLimited: false, foundChange: true,
    error: 'circuit breaker: could not count the people changed by checks in 24 hours (1000 check runs or more); nothing was written',
  })
  for (const n of WRITES) assert.ok(!f.names().includes(n), n)
  assert.equal(a.state.vgCursor, 5)

  const d = setup()
  assert.equal((await runCheck(d.args({ state: { cache: cacheOf([c]), lglCursor: null, vgCursor: 5 } }))).outcome, 'ok')
  assert.match(d.out.at(-1), /^CHECK OK vg-check dry-run people=1 .* breaker=would-trip lgl-writes=0 lgl-stale=0 lgl-refused=0$/)
})

test('a feed page that says more but does not advance fails the vg check', async () => {
  const f = fakes({ feed: [{ lastAuditId: 5, more: true, persons: [] }, { lastAuditId: 5, more: true, persons: [] }] })
  const a = f.args()
  const r = await runCheck(a)
  assert.equal(r.outcome, 'failed')
  assert.match(r.error, /^the VG change feed did not advance past audit id 5 \(more: true\)/)
  assert.equal(f.calls.filter((x) => x[0] === 'getChanges').length, 1)
  assert.equal(a.state.vgCursor, 5)
  const g = fakes({ feed: [{ lastAuditId: null, more: true, persons: [] }] })
  assert.match((await runCheck(g.args())).error, /did not advance past audit id 5/)
})

test('a successful full pass resets the check breaker window', async () => {
  const c = con(101)
  const runs = [
    { runId: 1, kind: 'vg-check', result: 'ok', startedAt: '2026-11-15T02:00:00.000Z', counts: { breakerPeople: 50 } },
    { runId: 2, kind: 'full', result: 'failed', startedAt: '2026-11-15T04:00:00.000Z', counts: {} },
    { runId: 3, kind: 'full', result: 'ok', startedAt: '2026-11-15T03:00:00.000Z', counts: {} },
    { runId: 4, kind: 'lgl-check', result: 'ok', startedAt: '2026-11-15T05:00:00.000Z', counts: { breakerPeople: 49 } },
  ]
  const f = fakes({ persons: [per(7, 101)], memory: agreedAt(c, 7), feed: feedOf(7), lglRecords: { 101: con(101, { first_name: 'Janet' }) }, runs })
  const a = f.args({ writeVg: true, state: { cache: cacheOf([c]), lglCursor: null, vgCursor: 5 } })
  const r = await runCheck(a)
  assert.equal(r.outcome, 'ok', r.error) // 49 + 1: the 50 before the full pass no longer count
  assert.equal(r.breaker, false)
  assert.deepEqual(f.calls.filter((x) => x[0] === 'recentRuns').map((x) => x[1]).slice(0, 2),
    [{ kinds: ['full'], limit: 20 }, { kinds: ['vg-check', 'lgl-check'], since: '2026-11-15T03:00:00.000Z', limit: 1000 }])
  assert.ok(f.names().includes('patchPerson'))

  // one more person over the limit within the window trips it
  const g = fakes({ persons: [per(7, 101)], memory: agreedAt(c, 7), feed: feedOf(7), lglRecords: { 101: con(101, { first_name: 'Janet' }) },
    runs: [...runs, { runId: 5, kind: 'vg-check', result: 'ok', startedAt: '2026-11-15T06:00:00.000Z', counts: { breakerPeople: 1 } }] })
  const b = await runCheck(g.args({ writeVg: true, state: { cache: cacheOf([c]), lglCursor: null, vgCursor: 5 } }))
  assert.deepEqual([b.breaker, b.error], [true, 'circuit breaker: 51 people changed by checks in 24 hours, more than the limit of 50'])
})

test('gift-date-only runs do not trip it', async () => {
  const c = con(101)
  const runs = [{ runId: 1, kind: 'lgl-check', result: 'ok', startedAt: '2026-11-15T09:00:00.000Z', counts: { breakerPeople: 50, peopleChanged: 200 } }]
  const f = fakes({ persons: [per(7, 101, { donor: linkTo(101, '2026-01-05') })], memory: agreedAt(c, 7), feed: feedOf(7), lglRecords: { 101: c }, runs })
  const a = f.args({ writeVg: true, state: { cache: cacheOf([c]), lglCursor: null, vgCursor: 5 } })
  const r = await runCheck(a)
  assert.equal(r.outcome, 'ok', r.error)
  assert.equal(r.breaker, false)
  assert.ok(f.names().includes('putDonor'))
  const fin = f.calls.find((x) => x[0] === 'finishRun')[2]
  assert.deepEqual([fin.counts.peopleChanged, fin.counts.breakerPeople], [1, 0])
})

test('a 503 from VG adds the api state to the error', async () => {
  const down = async () => { throw Object.assign(new Error('VG GET /persons → 503: down'), { status: 503 }) }
  const f = fakes({
    feed: feedOf(7),
    vgOverrides: {
      listPersons: down,
      apiState: async () => ({ currentState: 'unavailable', since: '2026-11-15T09:58:00.000Z', dependencies: { db: false, oidc: true } }),
    },
  })
  const r = await runCheck(f.args())
  assert.deepEqual([r.outcome, r.final, r.rateLimited], ['failed', false, false])
  assert.equal(r.error, 'VG GET /persons → 503: down (VG API unavailable since 2026-11-15T09:58:00.000Z; db down)')

  const g = fakes({ feed: feedOf(7), vgOverrides: { listPersons: down, apiState: async () => { throw new Error('fetch failed') } } })
  assert.equal((await runCheck(g.args())).error, 'VG GET /persons → 503: down (VG API state not reachable)')

  // a 4xx answer is the API answering: no state lookup
  const h = fakes({ feed: feedOf(7), vgOverrides: { listPersons: async () => { throw Object.assign(new Error('VG GET /persons → 403: no'), { status: 403 }) } } })
  assert.equal((await runCheck(h.args())).error, 'VG GET /persons → 403: no')
  assert.ok(!h.names().includes('apiState'))
})

test('a 401 token refusal is final and makes no apiState call', async () => {
  const f = fakes({
    vgOverrides: { getChanges: async () => { throw Object.assign(new Error('Keycloak token request → 401: refused'), { status: 401, final: true }) } },
  })
  const a = f.args()
  const r = await runCheck(a)
  assert.deepEqual(r, { outcome: 'failed', final: true, breaker: false, rateLimited: false, foundChange: false, error: 'Keycloak token request → 401: refused' })
  assert.ok(!f.names().includes('apiState'))
  assert.equal(a.state.vgCursor, 5)

  // a token request that fails another way gets no state lookup either
  const g = fakes({ vgOverrides: { getChanges: async () => { throw Object.assign(new Error('Keycloak token request → 503: busy'), { status: 503, final: false }) } } })
  assert.equal((await runCheck(g.args())).final, false)
  assert.ok(!g.names().includes('apiState'))
})

test('a stop during apply returns stopped and does not advance the cursor', async () => {
  const controller = new AbortController()
  const a1 = con(101)
  const a2 = con(102)
  const f = fakes({
    persons: [per(7, 101), per(8, 102)], memory: [...agreedAt(a1, 7), ...agreedAt(a2, 8)], feed: feedOf(7, 8),
    lglRecords: { 101: con(101, { first_name: 'Janet' }), 102: con(102, { first_name: 'Janet' }) },
  })
  f.vg.patchPerson = async (...x) => { f.calls.push(['patchPerson', ...x]); controller.abort('shutdown'); return {} }
  const cache = cacheOf([a1, a2])
  const a = f.args({ writeVg: true, signal: controller.signal, state: { cache, lglCursor: null, vgCursor: 5 } })
  const r = await runCheck(a)
  assert.deepEqual(r, { outcome: 'stopped', final: false, breaker: false, rateLimited: false, foundChange: true, error: null })
  assert.equal(f.calls.filter((x) => x[0] === 'patchPerson').length, 1)
  const fins = f.calls.filter((x) => x[0] === 'finishRun')
  assert.equal(fins.length, 1)
  assert.deepEqual([fins[0][2].result, fins[0][2].error], ['failed', 'stopped by shutdown'])
  assert.equal(a.state.vgCursor, 5)
  assert.equal(a.state.cache, cache)
  assert.deepEqual(f.out, [])
})

test('a timeout fails the check with the check timeout', async () => {
  const controller = new AbortController()
  controller.abort('timeout')
  const f = fakes({ feed: feedOf(7) })
  const r = await runCheck(f.args({ signal: controller.signal }))
  assert.deepEqual([r.outcome, r.error], ['failed', 'timed out after 5 minutes'])
})

test('a live run blocks a write check', async () => {
  const c = con(101)
  const runs = [{ runId: 3, kind: 'full', result: 'running', startedAt: '2026-11-15T09:45:00.000Z' }]
  const f = fakes({ persons: [per(7, 101, { firstName: 'Janet' })], memory: agreedAt(c, 7), feed: feedOf(7), lglRecords: { 101: c }, runs })
  const a = f.args({ writeVg: true, state: { cache: cacheOf([c]), lglCursor: null, vgCursor: 5 } })
  const r = await runCheck(a)
  assert.equal(r.outcome, 'failed')
  assert.match(r.error, /another sync run \(id 3, full\)/)
  assert.ok(!f.names().includes('startRun'))
  assert.equal(a.state.vgCursor, 5)
})

// Step 7: checks write to LGL. VG changed person 7's email since the agreed value.
const allowAll = { ...config, lglWriteAllow: 'all' }
const newEmail = (personId, cid) => ({ ...per(personId, cid), email: 'jane.new@example.org' })

test('vg-check: a vg-changed email is written to LGL', async () => {
  const c = con(101)
  const f = fakes({ persons: [newEmail(7, 101)], memory: agreedAt(c, 7), feed: feedOf(7), lglRecords: { 101: c } })
  const a = f.args({ config: allowAll, writeVg: true, writeLgl: true, state: { cache: cacheOf([c]), lglCursor: null, vgCursor: 5 } })
  const r = await runCheck(a)
  assert.equal(r.outcome, 'ok', r.error)
  assert.equal(f.calls.filter((x) => x[0] === 'getSyncLog').length, 1)
  assert.deepEqual(f.calls.find((x) => x[0] === 'startRun')[1].switches, { writeVg: true, writeLgl: true })
  // one attempt per LGL request inside a check
  assert.deepEqual(f.calls.find((x) => x[0] === 'getConstituentFull').slice(1), ['101', { attempts: 1 }])
  const add = f.calls.find((x) => x[0] === 'addEntry')
  assert.deepEqual([String(add[1]), add[3].address, add[4]], ['101', 'jane.new@example.org', { attempts: 1 }])
  const retire = f.calls.find((x) => x[0] === 'patchEntry')
  assert.deepEqual([String(retire[2]), retire[3]], ['1011', { not_current: true }])
  assert.ok(f.names().includes('appendSyncLog'))
  const fin = f.calls.find((x) => x[0] === 'finishRun')[2]
  assert.deepEqual(fin.counts.apply.lgl, { written: 1, stale: 0, refused: 0 })
  assert.deepEqual([fin.counts.peopleChanged, fin.counts.breakerPeople], [1, 1])
  assert.equal(f.out.at(-1), 'CHECK OK vg-check write-vg people=1 writes=0 deferred=0 links=0 creates=0 holdsOpened=0 holdsClosed=0 lgl-writes=1 lgl-stale=0 lgl-refused=0')
  assert.ok(lines(f.files[0]).some((d) => d.outcome === 'write-lgl' && d.field === 'email'))
})

test('vg-check: dry, the LGL write is deferred and its calls are in the decisions file', async () => {
  const c = con(101)
  const f = fakes({ persons: [newEmail(7, 101)], memory: agreedAt(c, 7), feed: feedOf(7), lglRecords: { 101: c } })
  const r = await runCheck(f.args({ config: allowAll, state: { cache: cacheOf([c]), lglCursor: null, vgCursor: 5 } }))
  assert.equal(r.outcome, 'ok', r.error)
  for (const n of [...WRITES, ...LGL_WRITES, 'getConstituentFull']) assert.ok(!f.names().includes(n), n)
  assert.ok(f.names().includes('getSyncLog'), 'a dry check reads the log as a write check would')
  const d = lines(f.files[0]).find((x) => x.field === 'email')
  assert.deepEqual([d.outcome, d.note], ['deferred', 'write-lgl off'])
  assert.ok(d.calls.length >= 1)
  assert.equal(f.out.at(-1), 'CHECK OK vg-check dry-run people=0 writes=0 deferred=1 links=0 creates=0 holdsOpened=0 holdsClosed=0 lgl-writes=1 lgl-stale=0 lgl-refused=0')
})

test('lgl-check: the sync\'s own write comes back as same and writes nothing', async () => {
  // After an LGL write: the memory holds VG's value as agreed, with the entry written, and LGL's
  // fresh record (its updated_at moved by the write) holds that same value.
  const before = con(101, { updated_at: '2026-11-15T08:00:00Z' })
  const after = con(101, {
    updated_at: '2026-11-15T09:30:00Z',
    email_addresses: [{ id: 900, address: 'jane.new@example.org', is_preferred: true, not_current: false }],
  })
  const memory = agreedAt(after, 7).map((m) => (m.field === 'email' ? { ...m, lglEntryId: '900' } : m))
  assert.equal(memory.find((m) => m.field === 'email').value, 'jane.new@example.org')
  const f = fakes({ persons: [newEmail(7, 101)], memory, since: { constituents: [after], gifts: [] } })
  const a = f.args({
    kind: 'lgl-check', config: allowAll, writeVg: true, writeLgl: true,
    state: { cache: cacheOf([before]), lglCursor: '2026-11-15T09:00:00.000Z', vgCursor: 5 },
  })
  const r = await runCheck(a)
  assert.deepEqual(r, { outcome: 'ok', final: false, breaker: false, rateLimited: false, foundChange: false, error: null })
  // nothing to write to LGL, so the flapping guard looks nobody up: the log is not read
  for (const n of [...WRITES, ...LGL_WRITES, 'getConstituentFull', 'getSyncLog']) assert.ok(!f.names().includes(n), n)
  assert.deepEqual([f.out, f.files], [[], []])
  assert.equal(a.state.lglCursor, '2026-11-15T09:30:00Z')
})

test('a check planned from the cache (more than 20 touched) skips a field LGL changed since', async () => {
  const cs = Array.from({ length: 21 }, (_, i) => con(101 + i))
  const persons = cs.map((c, i) => (i === 0 ? newEmail(7, c.id) : per(7 + i, c.id)))
  // LGL's email for 101 changed after the cache was filled: the fresh read before the write sees it
  const moved = { ...cs[0], email_addresses: [{ id: 1011, address: 'jane.moved@example.org', is_preferred: true }] }
  const f = fakes({
    persons, memory: cs.flatMap((c, i) => agreedAt(c, 7 + i)), feed: feedOf(...persons.map((p) => p.personId)),
    lglRecords: { 101: moved },
  })
  const a = f.args({ config: allowAll, writeVg: true, writeLgl: true, state: { cache: cacheOf(cs), lglCursor: null, vgCursor: 5 } })
  const r = await runCheck(a)
  assert.equal(r.outcome, 'ok', r.error)
  assert.ok(!f.names().includes('getConstituent'), 'the plan is made from the cache')
  assert.deepEqual(f.calls.filter((x) => x[0] === 'getConstituentFull').map((x) => x[1]), ['101'])
  for (const n of LGL_WRITES) assert.ok(!f.names().includes(n), n)
  assert.ok(!(f.calls.find((x) => x[0] === 'putSyncFields')?.[1] ?? []).some((m) => m.field === 'email'), 'no memory for the stale field')
  assert.match(f.out.at(-1), /^CHECK OK vg-check write-vg people=1 .* lgl-writes=0 lgl-stale=1 lgl-refused=0$/)
  assert.equal(a.state.vgCursor, 12)
})

test('an LGL 429 while writing keeps source lgl: the check is rate-limited, with no VG API note', async () => {
  const c = con(101)
  const f = fakes({
    persons: [newEmail(7, 101)], memory: agreedAt(c, 7), feed: feedOf(7), lglRecords: { 101: c },
    lglOverrides: { addEntry: async () => { throw Object.assign(new Error('LGL POST /constituents/101/email_addresses → 429: slow down'), { status: 429 }) } },
  })
  const a = f.args({ config: allowAll, writeVg: true, writeLgl: true, state: { cache: cacheOf([c]), lglCursor: null, vgCursor: 5 } })
  const r = await runCheck(a)
  assert.equal(r.outcome, 'failed')
  assert.equal(r.rateLimited, true)
  assert.equal(r.error, 'LGL POST /constituents/101/email_addresses → 429: slow down')
  assert.ok(!f.names().includes('apiState'))
  assert.equal(f.calls.find((x) => x[0] === 'finishRun')[2].result, 'failed')
  assert.equal(a.state.vgCursor, 5)
})

test('lglPaused fails a write check from the cache that would send to LGL, before any write', async () => {
  const cs = Array.from({ length: 21 }, (_, i) => con(101 + i))
  const persons = cs.map((c, i) => (i === 0 ? newEmail(7, c.id) : per(7 + i, c.id)))
  const f = fakes({ persons, memory: cs.flatMap((c, i) => agreedAt(c, 7 + i)), feed: feedOf(...persons.map((p) => p.personId)), lglRecords: { 101: cs[0] } })
  const a = f.args({ config: allowAll, writeVg: true, writeLgl: true, lglPaused: true, state: { cache: cacheOf(cs), lglCursor: null, vgCursor: 5 } })
  const r = await runCheck(a)
  assert.deepEqual([r.outcome, r.error], ['failed', 'LGL rate-limited'])
  for (const n of [...WRITES, ...LGL_WRITES, 'getConstituentFull']) assert.ok(!f.names().includes(n), n)
  assert.equal(a.state.vgCursor, 5)
})

test('a check: 5000 LGL log rows fails safe, nothing written', async () => {
  const c = con(101)
  const rows = Array.from({ length: 5000 }, (_, i) => ({ runId: String(i), personId: '7', field: 'email', outcome: 'written' }))
  const f = fakes({ persons: [newEmail(7, 101)], memory: agreedAt(c, 7), feed: feedOf(7), lglRecords: { 101: c }, vgOverrides: { getSyncLog: async () => rows } })
  const r = await runCheck(f.args({ config: allowAll, writeVg: true, writeLgl: true, state: { cache: cacheOf([c]), lglCursor: null, vgCursor: 5 } }))
  assert.equal(r.outcome, 'failed')
  assert.match(r.error, /5000 rows.*cannot count/)
  for (const n of [...WRITES, ...LGL_WRITES]) assert.ok(!f.names().includes(n), n)
})
