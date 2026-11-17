import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runFullPass } from '../../src/lgl-vg/pass.js'
import { planLinked } from '../../src/lgl-vg/plan.js'
import { parsePolicy } from '../../src/lgl-vg/policy.js'
import { FIELDS, lglFields } from '../../src/lgl-vg/fields.js'

const policy = parsePolicy(readFileSync(new URL('../../policy.json', import.meta.url), 'utf8'))
const NOW = Date.parse('2026-11-12T10:00:00.000Z')
const baseConfig = {
  lgl: { membershipFundId: 5, paypalPaymentTypeId: 2 },
  circuitBreakerPeople: 50, maxConstituentDropPercent: 10, imageRevision: 'abc123',
}

const con = (id, o = {}) => ({
  id, first_name: 'Jane', last_name: 'Doe', nick_name: null, suffix: null,
  is_deceased: false, deceased_date: null, is_org: false, updated_at: '2026-11-10T12:00:00Z',
  email_addresses: [{ id: 11, address: 'jane@example.org', is_preferred: true }],
  street_addresses: [{ id: 12, street: '12 Elm St', city: 'Springfield', state: 'RI', zip5: '99999', is_preferred: true }],
  phone_numbers: [],
  ...o,
})
const per = (personId, lglId) => ({
  personId: String(personId), deceased: false, email: 'jane@example.org', phone: { phone: null, cell: null },
  donor: { lglConstituentId: String(lglId), lastGiftDate: '2026-01-05' },
  detail: {
    firstName: 'Jane', lastName: 'Doe', suffix: null, nickname: null,
    street: '12 Elm St', unit: null, city: 'Springfield', state: 'RI', zip: '99999', deceasedDate: null,
  },
})
const gift = (cid) => ({ id: cid, constituent_id: cid, received_date: '2026-01-05', gift_type_id: 1, fund_id: 9, payment_type_id: 1 })

// n linked pairs; LGL has renamed the first name of `changed` of them since the agreed memory
function world(n, changed) {
  const base = Array.from({ length: n }, (_, i) => con(101 + i))
  const constituents = base.map((c, i) => (i < changed ? { ...c, first_name: 'Janet' } : c))
  const persons = base.map((c, i) => per(7 + i, c.id))
  const memory = base.flatMap((c, i) => FIELDS.map((f) => ({
    personId: String(7 + i), field: f, lglConstituentId: String(c.id), value: lglFields(c).values[f], lglEntryId: null, agreedAt: '2026-11-01T00:00:00Z',
  })))
  return { constituents, gifts: base.map((c) => gift(c.id)), persons, memory }
}

function fakes({ w = world(1, 1), last = null, applyFails = false, holds = [], runs = [], pages = [{ lastAuditId: 12, more: false, persons: [] }], syncLog = [] } = {}) {
  const calls = []
  const rec = (name, ret) => async (...a) => { calls.push([name, ...a]); return typeof ret === 'function' ? ret(...a) : ret }
  const vg = {
    whoAmI: rec('whoAmI', { userId: 1 }),
    listPersons: rec('listPersons', w.persons),
    getSyncFields: rec('getSyncFields', w.memory),
    getSyncHolds: rec('getSyncHolds', holds),
    lastFullRun: rec('lastFullRun', last),
    recentRuns: rec('recentRuns', runs),
    getChanges: rec('getChanges', () => pages.shift() ?? { lastAuditId: null, more: false, persons: [] }),
    startRun: rec('startRun', { runId: 9 }),
    finishRun: rec('finishRun', {}),
    getLinkedPersons: rec('getLinkedPersons', (cid) => w.persons.filter((p) => p.donor.lglConstituentId === String(cid))),
    geocodeTown: rec('geocodeTown', { town: 'Springfield' }),
    patchPerson: rec('patchPerson', applyFails ? () => { throw new Error(applyFails === true ? 'boom' : applyFails) } : {}),
    putDonor: rec('putDonor', {}),
    putSyncFields: rec('putSyncFields', 1),
    createSyncHolds: rec('createSyncHolds', []),
    patchSyncHolds: rec('patchSyncHolds', 1),
    getSyncLog: rec('getSyncLog', syncLog),
    appendSyncLog: rec('appendSyncLog', (rows) => rows.length),
  }
  const lgl = {
    pullConstituents: rec('pullConstituents', w.constituents), pullGifts: rec('pullGifts', w.gifts),
    getConstituentFull: rec('getConstituentFull', (id) => structuredClone(w.constituents.find((c) => String(c.id) === String(id)))),
    addEntry: rec('addEntry', (id, kind, body) => ({ id: 900, not_current: false, ...body })),
    patchEntry: rec('patchEntry', (kind, entryId, body) => ({ ...body })),
    patchConstituent: rec('patchConstituent', (id, body) => ({ ...body })),
    listEntries: rec('listEntries', []),
  }
  const out = []
  const files = []
  const args = (extra = {}) => ({
    config: baseConfig, policy, vg, lgl, snapshot: null, writeVg: false, maxPeople: null,
    now: () => NOW, writeLines: async (p, t) => files.push({ path: p, text: t }), stdout: (t) => out.push(t), out: 'out',
    ...extra,
  })
  const names = () => calls.map((c) => c[0])
  return { vg, lgl, calls, out, files, args, names }
}

const WRITES = ['startRun', 'patchPerson', 'putSyncFields', 'putDonor', 'createSyncHolds', 'patchSyncHolds', 'finishRun']
const LGL_WRITES = ['addEntry', 'patchEntry', 'patchConstituent', 'appendSyncLog']

test('dry run: only GETs, a decisions file, PASS OK dry-run', async () => {
  const f = fakes()
  assert.equal(await runFullPass(f.args()), 0)
  for (const n of WRITES) assert.ok(!f.names().includes(n), n)
  assert.equal(f.files.length, 1)
  assert.equal(f.files[0].path, 'out/full-2026-11-12T10-00-00-000Z.jsonl')
  assert.ok(f.files[0].text.includes('write-vg'))
  assert.match(f.out.at(-1), /^PASS OK full dry-run people=1 writes=1 /)
  assert.match(f.out.at(-1), /holdsOpen=0 holdsPlanned=0 lgl-writes=0 lgl-stale=0 lgl-refused=0$/)
})

test('write run: startRun, writes, finishRun ok with a cursor five minutes before the newest update', async () => {
  const f = fakes()
  assert.equal(await runFullPass(f.args({ writeVg: true })), 0)
  const names = f.names()
  assert.ok(names.indexOf('startRun') < names.indexOf('patchPerson'))
  assert.ok(names.indexOf('patchPerson') < names.indexOf('finishRun'))
  const start = f.calls.find((c) => c[0] === 'startRun')[1]
  assert.deepEqual(start, { kind: 'full', switches: { writeVg: true, writeLgl: false }, imageRevision: 'abc123', policyHash: policy.hash })
  const fin = f.calls.find((c) => c[0] === 'finishRun')
  assert.equal(fin[1], 9)
  assert.equal(fin[2].result, 'ok')
  assert.equal(fin[2].lglCursor, '2026-11-10T11:55:00.000Z')
  assert.equal(fin[2].vgCursor, 12)
  assert.equal(fin[2].counts.constituents, 1)
  assert.match(f.out.at(-1), /^PASS OK full write-vg people=1 writes=1 stale=0 refused=0 deferred=0 links=0 creates=0 unlinks=0 holdsOpened=0 holdsClosed=0 holdsOpen=0 lgl-writes=0 lgl-stale=0 lgl-refused=0$/)
  assert.ok(f.files[0].text.includes('"outcome":"written"'))
})

test('a snapshot gives a null cursor and no LGL call', async () => {
  const w = world(1, 1)
  const f = fakes({ w })
  await runFullPass(f.args({ writeVg: true, lgl: null, snapshot: { constituents: w.constituents, gifts: w.gifts } }))
  assert.equal(f.calls.find((c) => c[0] === 'finishRun')[2].lglCursor, null)
})

test('a pull far below the last ok run fails without writing', async () => {
  const w = world(80, 0)
  const f = fakes({ w, last: { runId: 2, result: 'ok', counts: { constituents: 100 } } })
  assert.equal(await runFullPass(f.args({ writeVg: true })), 1)
  assert.match(f.out.at(-1), /^PASS FAILED full /)
  for (const n of WRITES) assert.ok(!f.names().includes(n), n)
  assert.equal(f.files.length, 0)
})

test('circuit breaker on a write run: 3 people over a limit of 2 fails naming both; --max-people 3 writes', async () => {
  const w = world(3, 3)
  const f = fakes({ w })
  assert.equal(await runFullPass(f.args({ writeVg: true, config: { ...baseConfig, circuitBreakerPeople: 2 } })), 1)
  assert.match(f.out.at(-1), /^PASS FAILED full .*3 people.*limit of 2.*--max-people/)
  assert.ok(!f.names().includes('startRun'))
  assert.equal(f.files.length, 1) // planning ran, so the decisions are saved

  const g = fakes({ w })
  assert.equal(await runFullPass(g.args({ writeVg: true, maxPeople: 3, config: { ...baseConfig, circuitBreakerPeople: 2 } })), 0)
  assert.equal(g.names().filter((n) => n === 'patchPerson').length, 3)
})

test('circuit breaker on a dry run: the summary prints, a would-trip line, PASS OK with breaker=would-trip', async () => {
  const f = fakes({ w: world(3, 3) })
  assert.equal(await runFullPass(f.args({ config: { ...baseConfig, circuitBreakerPeople: 2 } })), 0)
  for (const n of WRITES) assert.ok(!f.names().includes(n), n)
  assert.equal(JSON.parse(f.out.at(-3)).counts.peopleChanged, 3)
  assert.match(f.out.at(-2), /would trip.*3 people.*limit of 2.*--max-people/)
  assert.match(f.out.at(-1), /^PASS OK full dry-run people=3 .* breaker=would-trip lgl-writes=0 lgl-stale=0 lgl-refused=0$/)
  assert.equal(f.files.length, 1)

  const g = fakes({ w: world(1, 1) })
  await runFullPass(g.args())
  assert.ok(!g.out.some((l) => /would trip/.test(l)))
  assert.doesNotMatch(g.out.at(-1), /breaker/)
})

test('an apply error after startRun marks the run failed and exits 1', async () => {
  const f = fakes({ applyFails: true })
  assert.equal(await runFullPass(f.args({ writeVg: true })), 1)
  const fins = f.calls.filter((c) => c[0] === 'finishRun')
  assert.equal(fins.length, 1)
  // SyncRunPatch.counts is a non-nullable object: the failed finish leaves it out
  assert.deepEqual(fins[0][2], { result: 'failed', lglCursor: null, vgCursor: null, error: 'boom' })
  assert.match(f.out.at(-1), /^PASS FAILED full boom/)
  assert.equal(f.files.length, 1)
})

test('a failed finish truncates the error to 1000 characters', async () => {
  const f = fakes({ applyFails: 'x'.repeat(1500) })
  assert.equal(await runFullPass(f.args({ writeVg: true })), 1)
  const body = f.calls.find((c) => c[0] === 'finishRun')[2]
  assert.equal(body.error, 'x'.repeat(1000))
  assert.ok(!Object.hasOwn(body, 'counts'))
})

test('the drop check: skipped with one line when there is no earlier ok run, silent when it runs', async () => {
  const f = fakes()
  await runFullPass(f.args())
  assert.ok(f.out.some((l) => /constituent-drop check is skipped/.test(l)))
  const g = fakes({ last: { runId: 2, result: 'ok', counts: { constituents: 1 } } })
  await runFullPass(g.args())
  assert.ok(!g.out.some((l) => /constituent-drop check/.test(l)))
})

test('a dismissed vg-refused hold on the planned write: not written, not reopened', async () => {
  const w = world(1, 1)
  const fp = planLinked({ ...w, refusals: [], policy, config: baseConfig }).writes[0].fields.firstName.fingerprint
  const dismissed = { holdId: '60', lglConstituentId: '101', personId: '7', field: 'firstName', reason: 'vg-refused',
    fingerprint: fp, detail: { error: 'no' }, state: 'dismissed' }
  const f = fakes({ w, holds: [dismissed] })
  assert.equal(await runFullPass(f.args({ writeVg: true })), 0)
  assert.ok(!f.names().includes('patchPerson'))
  assert.ok(!f.names().includes('createSyncHolds'))
  assert.ok(!f.calls.some((c) => c[0] === 'patchSyncHolds' && c[1].some((x) => x.state === 'open')))
  assert.equal(f.calls.find((c) => c[0] === 'finishRun')[2].counts.apply.holds.stillDismissed, 1)
})

// --- unlinked donors in the pass ---
function unlinkedWorld() {
  // 101 linked and agreeing; 102 an unlinked donor matching person 8 by email and name; 103 new to VG
  const w = world(1, 0)
  const c2 = con(102, { email_addresses: [{ id: 21, address: 'ann@example.org', is_preferred: true }], first_name: 'Ann', last_name: 'Roe' })
  const c3 = con(103, { email_addresses: [{ id: 31, address: 'cy@example.org', is_preferred: true }], first_name: 'Cy', last_name: 'Poe', street_addresses: [] })
  const p8 = { ...per(8, 0), email: 'ann@example.org', donor: null, detail: { ...per(8, 0).detail, firstName: 'Ann', lastName: 'Roe' } }
  return { ...w, constituents: [...w.constituents, c2, c3], gifts: [...w.gifts, gift(102), gift(103)], persons: [...w.persons, p8] }
}

test('dry run: a link and a create are planned, counted as people, and printed', async () => {
  const f = fakes({ w: unlinkedWorld() })
  assert.equal(await runFullPass(f.args()), 0)
  assert.match(f.out.at(-1), /^PASS OK full dry-run people=2 writes=2 .* links=1 creates=1 unlinks=0 /)
  const lines = f.files[0].text.trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(lines.filter((d) => d.kind === 'unlinked').map((d) => [d.constituentId, d.action, d.outcome]), [['102', 'link', 'write-vg'], ['103', 'create', 'write-vg']])
})

test('write run: links and creates after one fresh read of every person', async () => {
  const w = unlinkedWorld()
  const f = fakes({ w })
  f.vg.createPerson = async (body) => { f.calls.push(['createPerson', body]); return { personId: '900' } }
  f.vg.createSyncHolds = async (items) => { f.calls.push(['createSyncHolds', items]); return items.map((h, i) => ({ holdId: `h${i}`, ...h })) }
  assert.equal(await runFullPass(f.args({ writeVg: true })), 0)
  const names = f.names()
  assert.equal(names.filter((n) => n === 'listPersons').length, 2)
  assert.deepEqual(f.calls.filter((c) => c[0] === 'putDonor').map((c) => [c[1], c[2].lglConstituentId]), [['8', '102'], ['900', '103']])
  assert.match(f.out.at(-1), /links=1 creates=1 unlinks=0 /)
})

test('the breaker counts links and creates as people changed', async () => {
  const f = fakes({ w: unlinkedWorld() })
  assert.equal(await runFullPass(f.args({ writeVg: true, config: { ...baseConfig, circuitBreakerPeople: 1 } })), 1)
  assert.match(f.out.at(-1), /^PASS FAILED full The plan changes 2 people, more than the limit of 1/)
})

test('a missing constituent with policy unlink: the donor row is removed and an unlinked notice opens', async () => {
  const w = world(1, 0)
  const f = fakes({ w: { ...w, constituents: [], gifts: [] } })
  f.vg.deleteDonor = async (id) => { f.calls.push(['deleteDonor', id]); return null }
  assert.equal(await runFullPass(f.args({ writeVg: true, config: { ...baseConfig, maxConstituentDropPercent: 100 } })), 0)
  assert.deepEqual(f.calls.filter((c) => c[0] === 'deleteDonor').map((c) => c[1]), ['7'])
  assert.deepEqual(f.calls.filter((c) => c[0] === 'createSyncHolds').flatMap((c) => c[1]).map((h) => [h.reason, h.personId]), [['unlinked', '7']])
  assert.match(f.out.at(-1), /unlinks=1 /)
})

// --- the service: stop on request, one write run at a time, what may be retried ---
const MIN = 60 * 1000
const withResult = (f, extra = {}) => {
  const results = []
  return { results, args: (e = {}) => f.args({ onResult: (r) => results.push(r), ...extra, ...e }) }
}

test('stop before the run row opens writes nothing', async () => {
  const f = fakes()
  const ac = new AbortController()
  f.lgl.pullConstituents = () => new Promise(() => { setImmediate(() => ac.abort('shutdown')) }) // hangs until the signal
  const r = withResult(f)
  assert.equal(await runFullPass(r.args({ writeVg: true, signal: ac.signal })), 0)
  assert.ok(!f.names().includes('startRun'))
  assert.equal(f.out.at(-1), 'PASS STOPPED full stopped by shutdown')
  assert.deepEqual(r.results, [{ outcome: 'stopped', retryable: false, error: null }])
})

test('stop during apply records the run as failed by shutdown', async () => {
  const f = fakes({ w: world(2, 2) })
  const ac = new AbortController()
  f.vg.patchPerson = async () => { ac.abort('shutdown'); return {} }
  const r = withResult(f)
  assert.equal(await runFullPass(r.args({ writeVg: true, signal: ac.signal })), 0)
  const fins = f.calls.filter((c) => c[0] === 'finishRun')
  assert.equal(fins.length, 1)
  assert.equal(fins[0][2].result, 'failed')
  assert.equal(fins[0][2].error, 'stopped by shutdown')
  assert.match(f.out.at(-1), /^PASS STOPPED full stopped by shutdown/)
  assert.equal(r.results.length, 1)
  assert.equal(r.results[0].outcome, 'stopped')
  assert.equal(f.files.length, 1)
})

test('a timed-out pass fails and may be retried', async () => {
  const f = fakes()
  const ac = new AbortController()
  f.lgl.pullGifts = () => new Promise(() => { setImmediate(() => ac.abort('timeout')) }) // hangs until the signal
  const r = withResult(f)
  assert.equal(await runFullPass(r.args({ writeVg: true, signal: ac.signal, config: { ...baseConfig, passTimeoutMinutes: 30 } })), 1)
  assert.equal(f.out.at(-1), 'PASS FAILED full timed out after 30 minutes')
  assert.deepEqual(r.results, [{ outcome: 'failed', retryable: true, error: 'timed out after 30 minutes' }])
})

test('a write run refuses while another run is running', async () => {
  const running = (mins) => [{ runId: 7, kind: 'full', result: 'running', startedAt: new Date(NOW - mins * MIN).toISOString() }]
  const cfg = { ...baseConfig, passTimeoutMinutes: 30 }
  const f = fakes({ runs: running(5) })
  const r = withResult(f)
  assert.equal(await runFullPass(r.args({ writeVg: true, config: cfg })), 1)
  assert.ok(!f.names().includes('startRun'))
  assert.match(f.out.at(-1), /^PASS FAILED full another sync run \(id 7, full\) started at .* is still running; nothing was written/)
  assert.equal(r.results[0].retryable, true)

  const old = fakes({ runs: running(31) })
  assert.equal(await runFullPass(old.args({ writeVg: true, config: cfg })), 0)
  assert.ok(old.names().includes('startRun'))

  const dry = fakes({ runs: running(5) })
  assert.equal(await runFullPass(dry.args({ config: cfg })), 0)
  assert.ok(dry.calls.filter((c) => c[0] === 'recentRuns').every((c) => c[1].limit === 50)) // only the cursor lookup
})

test('the circuit breaker and the drop check are final', async () => {
  const f = fakes({ w: world(3, 3) })
  const r = withResult(f)
  assert.equal(await runFullPass(r.args({ writeVg: true, config: { ...baseConfig, circuitBreakerPeople: 2 } })), 1)
  assert.equal(r.results[0].retryable, false)
  assert.equal(r.results[0].outcome, 'failed')

  const g = fakes({ last: { counts: { constituents: 100 } } })
  const q = withResult(g)
  assert.equal(await runFullPass(q.args({ writeVg: true })), 1)
  assert.equal(q.results[0].retryable, false)
})

test('a final token error is final, any other error is retryable', async () => {
  const f = fakes()
  f.vg.whoAmI = async () => { throw Object.assign(new Error('sign-in refused'), { final: true }) }
  const r = withResult(f)
  assert.equal(await runFullPass(r.args()), 1)
  assert.deepEqual(r.results, [{ outcome: 'failed', retryable: false, error: 'sign-in refused' }])

  const g = fakes({ applyFails: true })
  const q = withResult(g)
  await runFullPass(q.args({ writeVg: true }))
  assert.equal(q.results[0].retryable, true)
})

test('onResult reports ok once', async () => {
  const f = fakes()
  const r = withResult(f)
  await runFullPass(r.args())
  assert.deepEqual(r.results, [{
    outcome: 'ok', retryable: false, error: null,
    lgl: { constituents: f.lgl.pullConstituents ? (await f.lgl.pullConstituents()) : null, gifts: await f.lgl.pullGifts() },
    lglCursor: '2026-11-10T11:55:00.000Z', vgCursor: 12,
  }])
})

test('a full pass records the feed end as vgCursor', async () => {
  const f = fakes({ pages: [{ lastAuditId: 40, more: true, persons: [] }, { lastAuditId: 55, more: false, persons: [] }] })
  assert.equal(await runFullPass(f.args({ writeVg: true, vgCursorFrom: 7 })), 0)
  const feed = f.calls.filter((c) => c[0] === 'getChanges').map((c) => c[1])
  assert.deepEqual(feed, [7, 40])
  assert.ok(f.names().indexOf('getChanges') < f.names().indexOf('listPersons'))
  assert.equal(f.calls.find((c) => c[0] === 'finishRun')[2].vgCursor, 55)
  assert.ok(!f.calls.some((c) => c[0] === 'recentRuns' && c[1]?.limit === 50)) // the service's cursor wins
  // nothing new after the cursor: the cursor passed in is kept
  const g = fakes({ pages: [{ lastAuditId: null, more: false, persons: [] }] })
  await runFullPass(g.args({ writeVg: true, vgCursorFrom: 7 }))
  assert.equal(g.calls.find((c) => c[0] === 'finishRun')[2].vgCursor, 7)
})

test('a feed page that says more but does not advance fails the pass', async () => {
  const f = fakes({ pages: [{ lastAuditId: 40, more: true, persons: [] }, { lastAuditId: 40, more: true, persons: [] }, { lastAuditId: 40, more: true, persons: [] }] })
  assert.equal(await runFullPass(f.args({ writeVg: true, vgCursorFrom: 7 })), 1)
  assert.deepEqual(f.calls.filter((c) => c[0] === 'getChanges').map((c) => c[1]), [7, 40])
  assert.match(f.out.at(-1), /^PASS FAILED full the VG change feed did not advance past audit id 40 \(more: true\)/)
  for (const n of WRITES) assert.ok(!f.names().includes(n), n)
})

test('the feed is read from the newest run row\'s cursor when the service knows none', async () => {
  const runs = [{ runId: 3, vgCursor: null }, { runId: 2, vgCursor: 31 }, { runId: 1, vgCursor: 9 }]
  const f = fakes({ runs })
  await runFullPass(f.args({ writeVg: true }))
  assert.deepEqual(f.calls.find((c) => c[0] === 'recentRuns')[1], { limit: 50 })
  assert.equal(f.calls.find((c) => c[0] === 'getChanges')[1], 31)
  const g = fakes({ runs: [{ runId: 1, vgCursor: null }] })
  await runFullPass(g.args({ writeVg: true }))
  assert.equal(g.calls.find((c) => c[0] === 'getChanges')[1], 0)
})

test('onResult carries the pull and both cursors', async () => {
  const w = world(1, 1)
  const f = fakes({ w })
  const r = withResult(f)
  await runFullPass(r.args({ vgCursorFrom: 3 }))
  assert.deepEqual(r.results[0].lgl, { constituents: w.constituents, gifts: w.gifts })
  assert.equal(r.results[0].lglCursor, '2026-11-10T11:55:00.000Z')
  assert.equal(r.results[0].vgCursor, 12)
  const g = fakes({ w })
  const q = withResult(g)
  await runFullPass(q.args({ snapshot: { constituents: w.constituents, gifts: w.gifts } }))
  assert.ok(!('lgl' in q.results[0]))
  assert.equal(q.results[0].lglCursor, null)
})

test('quiet leaves out the counts block', async () => {
  const f = fakes()
  assert.equal(await runFullPass(f.args({ quiet: true })), 0)
  assert.ok(!f.out.some((l) => l.startsWith('{')))
  assert.match(f.out.at(-1), /^PASS OK full dry-run /)
  const g = fakes()
  await runFullPass(g.args())
  assert.ok(g.out.some((l) => l.startsWith('{')))
  assert.equal(f.out.at(-1), g.out.at(-1))
})

test('timeout during apply records the run as failed, retryable', async () => {
  const f = fakes({ w: world(2, 2) })
  const ac = new AbortController()
  f.vg.patchPerson = async () => { ac.abort('timeout'); return {} }
  const r = withResult(f)
  assert.equal(await runFullPass(r.args({ writeVg: true, signal: ac.signal, config: { ...baseConfig, passTimeoutMinutes: 30 } })), 1)
  const fins = f.calls.filter((c) => c[0] === 'finishRun')
  assert.equal(fins.length, 1)
  assert.equal(fins[0][2].error, 'timed out after 30 minutes')
  assert.equal(f.out.at(-1), 'PASS FAILED full timed out after 30 minutes')
  assert.deepEqual(r.results, [{ outcome: 'failed', retryable: true, error: 'timed out after 30 minutes' }])
})

test('an unparseable start on a running row still blocks a write run', async () => {
  const f = fakes({ runs: [{ runId: 3, kind: 'full', result: 'running', startedAt: 'garbage' }] })
  assert.equal(await runFullPass(f.args({ writeVg: true, config: { ...baseConfig, passTimeoutMinutes: 30 } })), 1)
  assert.ok(!f.names().includes('startRun'))
})

test('an onResult that throws does not print a second verdict', async () => {
  const f = fakes()
  await assert.rejects(runFullPass(f.args({ onResult: () => { throw new Error('x') } })))
  assert.equal(f.out.filter((l) => l.startsWith('PASS ')).length, 1)
})

// Step 7: writes to LGL. LGL and VG agreed on the email; VG has since changed it for each person.
function emailWorld(n) {
  const w = world(n, 0)
  w.persons = w.persons.map((p) => ({ ...p, email: 'jane.new@example.org' }))
  return w
}
const allowAll = { ...baseConfig, lglWriteAllow: 'all' }
let logId = 0
const logRow = (personId, field, runId) => ({
  logId: String(++logId), runId: String(runId), loggedAt: '2026-11-01T00:00:00.000Z', lglConstituentId: '101',
  personId: String(personId), field, case: 'vg-changed', request: { method: 'PATCH', path: '/x', body: {} },
  lglEntryId: null, oldValue: null, newValue: null, outcome: 'written', responseStatus: 200, note: null,
})
const decisionsOf = (f) => f.files[0].text.trim().split('\n').map((l) => JSON.parse(l))

test('full pass: the LGL write log of 30 days is read for each person the guard looks up, and counted per field', async () => {
  // three distinct runs wrote 7's email (run 3 logged two calls); other fields and people do not count
  const rows = [logRow(7, 'email', 1), logRow(7, 'email', 2), logRow(7, 'email', 3), logRow(7, 'email', 3),
    logRow(7, 'address', 4), logRow(7, 'address', 5), logRow(8, 'email', 6), logRow(8, 'email', 7)]
  const f = fakes({ w: emailWorld(1), syncLog: rows })
  assert.equal(await runFullPass(f.args({ config: allowAll, writeVg: true, writeLgl: true })), 0)
  const reads = f.calls.filter((c) => c[0] === 'getSyncLog')
  assert.deepEqual(reads, [['getSyncLog', { personId: '7', outcome: 'written', since: '2026-10-13T10:00:00.000Z', limit: 5000 }]])
  assert.ok(f.names().includes('addEntry'), 'three writes in thirty days: not flapping, written')

  // a fourth run makes it more than three: held flapping, nothing sent
  const g = fakes({ w: emailWorld(1), syncLog: [...rows, logRow(7, 'email', 9)] })
  assert.equal(await runFullPass(g.args({ config: allowAll, writeVg: true, writeLgl: true })), 0)
  for (const n of LGL_WRITES) assert.ok(!g.names().includes(n), n)
  const d = decisionsOf(g).find((x) => x.field === 'email')
  assert.deepEqual([d.outcome, d.note], ['hold', 'flapping'])
  const opened = g.calls.find((c) => c[0] === 'createSyncHolds')[1]
  assert.deepEqual(opened.map((h) => [h.personId, h.field, h.reason]), [['7', 'email', 'flapping']])

  // a run that writes VG but not LGL still finds it flapping, so it keeps that hold rather than closing it
  const h = fakes({ w: emailWorld(1), syncLog: [...rows, logRow(7, 'email', 9)] })
  assert.equal(await runFullPass(h.args({ config: allowAll, writeVg: true })), 0)
  const e = decisionsOf(h).find((x) => x.field === 'email')
  assert.deepEqual([e.outcome, e.note], ['hold', 'flapping'])
})

test('full pass: 5000 log rows (the limit) fails the pass safe: cannot count', async () => {
  const rows = Array.from({ length: 5000 }, (_, i) => logRow(7, 'email', i))
  const f = fakes({ w: emailWorld(1), syncLog: rows })
  let result
  assert.equal(await runFullPass(f.args({ config: allowAll, writeVg: true, writeLgl: true, onResult: (r) => { result = r } })), 1)
  assert.match(f.out.at(-1), /^PASS FAILED full .*5000 rows.*cannot count/)
  for (const n of [...WRITES, ...LGL_WRITES]) assert.ok(!f.names().includes(n), n)
  assert.equal(result.retryable, false)
})

test('full pass: dry with an allow-list prints calls and sends nothing', async () => {
  const f = fakes({ w: emailWorld(1) })
  assert.equal(await runFullPass(f.args({ config: allowAll })), 0)
  for (const n of [...WRITES, ...LGL_WRITES, 'getConstituentFull']) assert.ok(!f.names().includes(n), n)
  assert.ok(f.names().includes('getSyncLog'), 'a dry run reads the log as a write run would, so its holds match')
  const d = decisionsOf(f).find((x) => x.field === 'email')
  assert.deepEqual([d.outcome, d.note], ['deferred', 'write-lgl off'])
  assert.ok(d.calls.length >= 1, 'the decision carries the calls it would make')
  assert.match(f.out.at(-1), /deferred=1 .* lgl-writes=1 lgl-stale=0 lgl-refused=0$/)

  // writing LGL on but VG off (a dry pass): what would be sent is counted, nothing is sent
  const g = fakes({ w: emailWorld(1) })
  assert.equal(await runFullPass(g.args({ config: allowAll, writeLgl: true })), 0)
  for (const n of [...WRITES, ...LGL_WRITES, 'getConstituentFull']) assert.ok(!g.names().includes(n), n)
  assert.match(g.out.at(-1), /^PASS OK full dry-run people=1 .*deferred=0 .* lgl-writes=1 lgl-stale=0 lgl-refused=0$/)
})

test('full pass: --write-lgl sends allowed writes and records writeLgl true in the run row', async () => {
  const f = fakes({ w: emailWorld(2) })
  const config = { ...baseConfig, lglWriteAllow: new Set(['101']) }
  assert.equal(await runFullPass(f.args({ config, writeVg: true, writeLgl: true })), 0)
  const start = f.calls.find((c) => c[0] === 'startRun')[1]
  assert.deepEqual(start.switches, { writeVg: true, writeLgl: true })
  // 101 is on the allow-list: the new email is added and the one read retired; 102 is not
  assert.deepEqual(f.calls.filter((c) => c[0] === 'getConstituentFull').map((c) => String(c[1])), ['101'])
  const add = f.calls.find((c) => c[0] === 'addEntry')
  assert.equal(String(add[1]), '101')
  assert.equal(add[3].address, 'jane.new@example.org')
  assert.equal(f.calls.find((c) => c[0] === 'patchEntry')[3].not_current, true)
  const appended = f.calls.find((c) => c[0] === 'appendSyncLog')[1]
  assert.ok(appended.every((r) => r.runId === 9 || r.runId === '9'), 'log rows carry the run id')
  const not = decisionsOf(f).find((x) => x.field === 'email' && x.constituentId === '102')
  assert.deepEqual([not.outcome, not.note], ['deferred', 'not-allowed'])
  const fin = f.calls.find((c) => c[0] === 'finishRun')[2]
  assert.equal(fin.result, 'ok')
  assert.deepEqual(fin.counts.apply.lgl, { written: 1, stale: 0, refused: 0 })
  assert.equal(fin.counts.lglWritesPlanned, 1)
  // the agreed value is VG's
  const agreed = f.calls.find((c) => c[0] === 'putSyncFields')[1].find((r) => r.field === 'email')
  assert.equal(agreed.personId, '7')
})

test('full pass: PASS OK carries lgl-writes, lgl-stale, lgl-refused after the existing keys', async () => {
  // 101 is written; 102's LGL email moved between the pull and the fresh read (stale); 103 is refused
  const w = emailWorld(3)
  const f = fakes({ w })
  f.lgl.getConstituentFull = async (id) => {
    f.calls.push(['getConstituentFull', id])
    const c = structuredClone(w.constituents.find((x) => String(x.id) === String(id)))
    if (String(id) === '102') c.email_addresses[0].address = 'jane.moved@example.org'
    return c
  }
  f.lgl.addEntry = async (id, kind, body) => {
    f.calls.push(['addEntry', id, kind, body])
    if (String(id) === '103') throw Object.assign(new Error('LGL POST → 422: invalid'), { status: 422 })
    return { id: 900, not_current: false, ...body }
  }
  assert.equal(await runFullPass(f.args({ config: allowAll, writeVg: true, writeLgl: true })), 0)
  assert.match(f.out.at(-1), new RegExp('^PASS OK full write-vg people=3 writes=0 stale=0 refused=0 deferred=0 links=0 creates=0 unlinks=0 ' +
    'holdsOpened=1 holdsClosed=0 holdsOpen=1 lgl-writes=1 lgl-stale=1 lgl-refused=1$'))
})

test('full pass: LGL writes that will be sent count toward the breaker; deferred ones do not', async () => {
  const small = (o) => ({ ...baseConfig, circuitBreakerPeople: 1, ...o })
  // both allowed: two people, over the limit of one
  const f = fakes({ w: emailWorld(2) })
  assert.equal(await runFullPass(f.args({ config: small({ lglWriteAllow: 'all' }), writeVg: true, writeLgl: true })), 1)
  assert.match(f.out.at(-1), /^PASS FAILED full The plan changes 2 people, more than the limit of 1/)
  for (const n of [...WRITES, ...LGL_WRITES]) assert.ok(!f.names().includes(n), n)
  // one allowed: one person, inside the limit
  const g = fakes({ w: emailWorld(2) })
  assert.equal(await runFullPass(g.args({ config: small({ lglWriteAllow: new Set(['101']) }), writeVg: true, writeLgl: true })), 0)
  assert.match(g.out.at(-1), /^PASS OK full write-vg people=1 /)
  // writing LGL off: both deferred, nobody changed
  const h = fakes({ w: emailWorld(2) })
  assert.equal(await runFullPass(h.args({ config: small({ lglWriteAllow: 'all' }), writeVg: true })), 0)
  assert.match(h.out.at(-1), /^PASS OK full write-vg people=0 .*deferred=2 /)
})

test('full pass: an open lgl-refused hold on the same write is not tried again', async () => {
  const { fingerprint } = await import('../../src/lgl-vg/plan.js')
  const { comparable } = await import('../../src/lgl-vg/fields.js')
  const fp = fingerprint(['email', comparable('email', 'jane.new@example.org')])
  const holds = [{ holdId: '1', lglConstituentId: '101', personId: '7', field: 'email', reason: 'lgl-refused', fingerprint: fp, state: 'open', detail: { error: 'invalid' } }]
  const f = fakes({ w: emailWorld(1), holds })
  assert.equal(await runFullPass(f.args({ config: allowAll, writeVg: true, writeLgl: true })), 0)
  for (const n of ['addEntry', 'patchEntry', 'getConstituentFull']) assert.ok(!f.names().includes(n), n)
  const d = decisionsOf(f).find((x) => x.field === 'email')
  assert.deepEqual([d.outcome, d.note], ['hold', 'lgl-refused'])
})
