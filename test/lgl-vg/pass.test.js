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

function fakes({ w = world(1, 1), last = null, applyFails = false, holds = [] } = {}) {
  const calls = []
  const rec = (name, ret) => async (...a) => { calls.push([name, ...a]); return typeof ret === 'function' ? ret(...a) : ret }
  const vg = {
    whoAmI: rec('whoAmI', { userId: 1 }),
    listPersons: rec('listPersons', w.persons),
    getSyncFields: rec('getSyncFields', w.memory),
    getSyncHolds: rec('getSyncHolds', holds),
    lastFullRun: rec('lastFullRun', last),
    startRun: rec('startRun', { runId: 9 }),
    finishRun: rec('finishRun', {}),
    getLinkedPersons: rec('getLinkedPersons', (cid) => w.persons.filter((p) => p.donor.lglConstituentId === String(cid))),
    geocodeTown: rec('geocodeTown', { town: 'Springfield' }),
    patchPerson: rec('patchPerson', applyFails ? () => { throw new Error(applyFails === true ? 'boom' : applyFails) } : {}),
    putDonor: rec('putDonor', {}),
    putSyncFields: rec('putSyncFields', 1),
    createSyncHolds: rec('createSyncHolds', []),
    patchSyncHolds: rec('patchSyncHolds', 1),
  }
  const lgl = { pullConstituents: rec('pullConstituents', w.constituents), pullGifts: rec('pullGifts', w.gifts) }
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

test('dry run: only GETs, a decisions file, PASS OK dry-run', async () => {
  const f = fakes()
  assert.equal(await runFullPass(f.args()), 0)
  for (const n of WRITES) assert.ok(!f.names().includes(n), n)
  assert.equal(f.files.length, 1)
  assert.equal(f.files[0].path, 'out/full-2026-11-12T10-00-00-000Z.jsonl')
  assert.ok(f.files[0].text.includes('write-vg'))
  assert.match(f.out.at(-1), /^PASS OK full dry-run people=1 writes=1 /)
  assert.match(f.out.at(-1), /holdsOpen=0 holdsPlanned=0$/)
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
  assert.equal(fin[2].vgCursor, null)
  assert.equal(fin[2].counts.constituents, 1)
  assert.match(f.out.at(-1), /^PASS OK full write-vg people=1 writes=1 stale=0 refused=0 deferred=0 links=0 creates=0 unlinks=0 holdsOpened=0 holdsClosed=0 holdsOpen=0$/)
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
  assert.match(f.out.at(-1), /^PASS OK full dry-run people=3 .* breaker=would-trip$/)
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
