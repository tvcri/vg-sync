import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runOnce } from '../../src/vg-mailchimp/run.js'
import { createMailchimpClient, subscriberHash } from '../../src/vg-mailchimp/mailchimp.js'
import { createMockMailchimpFetch } from '../../src/vg-mailchimp/mailchimp-mock.js'

const NOW = Date.parse('2026-11-21T08:00:00.000Z')
const RUN_ID = '2026-11-21T08-00-00-000Z'
const DAY = 86_400_000
const ago = (days) => new Date(NOW - days * DAY).toISOString()

const config = (o = {}) => ({
  outDir: 'out', minCohort: 1, archiveAfterDays: 30, planLimit: 5000, limitMargin: 100,
  mailchimp: { listId: 'list1', listName: 'Test List', mock: null }, ...o,
})
const person = (id, email, o = {}) => ({
  personId: String(id), deceased: 0, email, memberStatus: 'Active', volunteerStatus: null, donor: null,
  detail: { firstName: `First${id}`, lastName: `Last${id}` }, ...o,
})
const member = (email, status, lastChanged = ago(1)) => ({
  email_address: email, status, last_changed: lastChanged, merge_fields: { FNAME: 'X', LNAME: 'Y' },
})

// One harness: the mock behind the real client, an event log shared by fetch, writeFile and sleep.
// wrap(next, url, init, state) lets a test inject behaviour around the mock.
function setup ({ persons = [], members = [], wrap, cfg, signal, ...args } = {}) {
  const state = { list: { id: 'list1', name: 'Test List' }, members }
  const events = []
  const files = {}
  const lines = []
  const inner = createMockMailchimpFetch({ state, persist: async () => {}, now: () => NOW })
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    events.push(`${method} ${new URL(url).pathname.replace(/^\/3\.0/, '')}`)
    return wrap ? wrap(inner, url, init, state) : inner(url, init)
  }
  const mc = createMailchimpClient({ apiKey: 'mock-us0', listId: 'list1', fetchImpl, sleep: async () => {}, baseUrl: 'https://mock.api.mailchimp.com/3.0' })
  const vg = { listPersons: async () => { events.push('VG persons'); return persons } }
  const deps = {
    config: config(cfg), vg, mc, now: () => NOW,
    sleep: async (ms) => { events.push(`sleep ${ms}`) },
    writeFile: async (p, text) => { events.push(`write ${p}`); files[p] = text },
    stdout: (t) => lines.push(t),
    signal,
    writeAdd: false, writeArchive: false, maxAdd: 50, maxArchive: 50,
    ...args,
  }
  const run = () => runOnce(deps)
  const records = () => {
    const text = files[`out/mailchimp-${RUN_ID}.jsonl`]
    assert.notEqual(text, undefined, 'records file written')
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  }
  const writes = () => events.filter((e) => /^(PUT|DELETE|POST|PATCH) /.test(e))
  const find = (email) => state.members.find((m) => m.email_address === email)
  return { run, state, events, files, lines, records, writes, find }
}

const summary = (lines) => lines.find((l) => l.startsWith('MAILCHIMP OK '))

test('dry run: no writes, no snapshot, left-out records, would-be counts', async () => {
  const h = setup({
    persons: [
      person(1, 'jane@example.org'),
      person(2, ''),
      person(3, 'new@example.org'),
      person(4, 'gone@example.org'),
    ],
    members: [
      member('jane@example.org', 'subscribed'),
      member('gone@example.org', 'unsubscribed', ago(5)),
      member('old@example.org', 'unsubscribed', ago(40)),
    ],
  })
  const r = await h.run()
  assert.deepEqual(r, { outcome: 'ok', retryable: false, runId: RUN_ID })
  assert.deepEqual(h.writes(), [])
  assert.equal(h.files[`out/audience-${RUN_ID}.json`], undefined)
  const recs = h.records()
  assert.ok(recs.every((x) => x.kind === 'left-out'))
  assert.deepEqual(recs.map((x) => x.reason).sort(), ['no-email', 'unsubscribed'])
  const noEmail = recs.find((x) => x.reason === 'no-email')
  assert.deepEqual(noEmail, { kind: 'left-out', reason: 'no-email', personIds: ['2'], email: null, hash: null, at: new Date(NOW).toISOString() })
  const unsub = recs.find((x) => x.reason === 'unsubscribed')
  assert.equal(unsub.status, 'unsubscribed')
  assert.equal(unsub.hash, subscriberHash('gone@example.org'))
  assert.deepEqual(h.lines, [summary(h.lines)])
  assert.match(h.lines[0], /^MAILCHIMP OK adds=1 archives=1 subscribed=1 left-out=2 /)
  assert.match(h.lines[0], /writes=add:off,archive:off$/)
  assert.equal(h.find('old@example.org').status, 'unsubscribed')
})

test('add: absent candidate becomes subscribed with FNAME/LNAME; recorded added', async () => {
  const h = setup({ persons: [person(1, 'Jane@Example.org', { detail: { firstName: 'Jane', lastName: 'Doe' } })], writeAdd: true })
  const r = await h.run()
  assert.equal(r.outcome, 'ok')
  const m = h.find('jane@example.org')
  assert.equal(m.status, 'subscribed')
  assert.deepEqual(m.merge_fields, { FNAME: 'Jane', LNAME: 'Doe' })
  assert.deepEqual(h.records(), [{
    kind: 'added', personIds: ['1'], email: 'jane@example.org', hash: subscriberHash('jane@example.org'), status: 'subscribed', at: new Date(NOW).toISOString(),
  }])
  assert.match(summary(h.lines), /adds=1 archives=0 subscribed=0 left-out=0 .* writes=add:on,archive:off$/)
})

test('archived candidate: looked up by hash, left-out/archived, no PUT', async () => {
  const h = setup({ persons: [person(1, 'jane@example.org')], members: [member('jane@example.org', 'archived')], writeAdd: true })
  await h.run()
  assert.deepEqual(h.writes(), [])
  assert.ok(h.events.includes(`GET /lists/list1/members/${subscriberHash('jane@example.org')}`))
  const [rec] = h.records()
  assert.equal(rec.kind, 'left-out')
  assert.equal(rec.reason, 'archived')
  assert.equal(rec.status, 'archived')
  assert.match(summary(h.lines), /adds=0 .*archived=1 /)
})

test('Review Focus 1: PUT answers 200 but contact reads archived → write-unconfirmed, adds=0', async () => {
  const wrap = async (next, url, init, state) => {
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body)
      state.members.push(member(body.email_address, 'archived'))
      return { ok: true, status: 200, statusText: '', headers: { get: () => null }, text: async () => JSON.stringify(body) }
    }
    return next(url, init)
  }
  const h = setup({ persons: [person(1, 'jane@example.org')], wrap, writeAdd: true })
  const r = await h.run()
  assert.equal(r.outcome, 'ok')
  const [rec] = h.records()
  assert.equal(rec.kind, 'left-out')
  assert.equal(rec.reason, 'write-unconfirmed')
  assert.equal(rec.status, 'archived')
  assert.match(summary(h.lines), /adds=0 .*other=1\) /)
})

test('archive: unsubscribed 31 days → archived and recorded; 10 days → untouched', async () => {
  const h = setup({
    persons: [person(1, 'jane@example.org')],
    members: [
      member('jane@example.org', 'subscribed'),
      member('old@example.org', 'unsubscribed', ago(31)),
      member('recent@example.org', 'unsubscribed', ago(10)),
    ],
    writeArchive: true,
  })
  const r = await h.run()
  assert.equal(r.outcome, 'ok')
  assert.equal(h.find('old@example.org').status, 'archived')
  assert.equal(h.find('recent@example.org').status, 'unsubscribed')
  assert.deepEqual(h.records(), [{
    kind: 'archived', personIds: [], email: 'old@example.org', hash: subscriberHash('old@example.org'), status: 'archived', at: new Date(NOW).toISOString(),
  }])
  assert.match(summary(h.lines), /adds=0 archives=1 subscribed=1 /)
})

test('Review Focus 2: contact resubscribed before archive → no DELETE, archive-skipped subscribed', async () => {
  const target = subscriberHash('old@example.org')
  const wrap = async (next, url, init, state) => {
    if ((init.method ?? 'GET') === 'GET' && url.toString().endsWith(`/members/${target}`)) {
      state.members.find((m) => m.email_address === 'old@example.org').status = 'subscribed'
    }
    return next(url, init)
  }
  const h = setup({ persons: [person(1, 'jane@example.org')], members: [member('jane@example.org', 'subscribed'), member('old@example.org', 'unsubscribed', ago(31))], wrap, writeArchive: true })
  await h.run()
  assert.deepEqual(h.writes(), [])
  const [rec] = h.records()
  assert.equal(rec.kind, 'archive-skipped')
  assert.equal(rec.status, 'subscribed')
  assert.equal(rec.reason, 'subscribed')
  assert.match(summary(h.lines), /archives=0 /)
})

test('archive: DELETE that does not read back archived is archive-skipped, not counted', async () => {
  const wrap = async (next, url, init) => {
    if (init.method === 'DELETE') return { ok: true, status: 204, statusText: '', headers: { get: () => null }, text: async () => '' }
    return next(url, init)
  }
  const h = setup({ persons: [person(1, 'jane@example.org')], members: [member('jane@example.org', 'subscribed'), member('old@example.org', 'unsubscribed', ago(31))], wrap, writeArchive: true })
  await h.run()
  const [rec] = h.records()
  assert.equal(rec.kind, 'archive-skipped')
  assert.equal(rec.status, 'unsubscribed')
  assert.match(summary(h.lines), /archives=0 /)
})

const threeOld = () => [
  member('jane@example.org', 'subscribed'),
  member('a@example.org', 'unsubscribed', ago(31)),
  member('b@example.org', 'unsubscribed', ago(40)),
  member('c@example.org', 'unsubscribed', ago(50)),
]

test('archive cap: 3 eligible, max 2 → none archived, CAP line; null → all archived', async () => {
  const h = setup({ persons: [person(1, 'jane@example.org')], members: threeOld(), writeArchive: true, maxArchive: 2 })
  const r = await h.run()
  assert.equal(r.outcome, 'ok')
  assert.deepEqual(h.writes(), [])
  assert.deepEqual(h.records(), [])
  assert.deepEqual(h.lines, ['MAILCHIMP CAP archive=3 max=2', summary(h.lines)])
  assert.match(summary(h.lines), /archives=0 /)

  const h2 = setup({ persons: [person(1, 'jane@example.org')], members: threeOld(), writeArchive: true, maxArchive: null })
  await h2.run()
  assert.equal(h2.writes().filter((w) => w.startsWith('DELETE')).length, 3)
  assert.match(summary(h2.lines), /archives=3 /)
})

const fillers = (n) => Array.from({ length: n }, (_, i) => member(`filler${i}@example.org`, 'subscribed'))
const threeNew = () => [person(1, 'n1@example.org'), person(2, 'n2@example.org'), person(3, 'n3@example.org')]

test('billing guard: room for 1 of 3 → 1 added, 2 limit, LIMIT line', async () => {
  // billable 7, limit 10, margin 2 → room 1
  const h = setup({ persons: threeNew(), members: fillers(7), cfg: { planLimit: 10, limitMargin: 2 }, writeAdd: true })
  await h.run()
  const recs = h.records()
  assert.deepEqual(recs.map((x) => [x.kind, x.reason, x.email]), [
    ['left-out', 'limit', 'n2@example.org'],
    ['left-out', 'limit', 'n3@example.org'],
    ['added', undefined, 'n1@example.org'],
  ])
  assert.deepEqual(h.lines, ['MAILCHIMP LIMIT billable=7 limit=10 margin=2 held=2', summary(h.lines)])
  assert.match(summary(h.lines), /adds=1 .*limit=2 .*billable=7\/10 /)
})

test('billing guard: archiving first frees room (archive 2, then 3 fit)', async () => {
  const members = [...fillers(5), member('u1@example.org', 'unsubscribed', ago(31)), member('u2@example.org', 'unsubscribed', ago(31))]
  const h = setup({ persons: threeNew(), members, cfg: { planLimit: 10, limitMargin: 2 }, writeAdd: true, writeArchive: true })
  await h.run()
  assert.deepEqual(h.lines, [summary(h.lines)])
  assert.match(summary(h.lines), /adds=3 archives=2 .*billable=5\/10 /)
})

test('add cap: more adds than MAX_ADD → none written, all left-out/cap, CAP line', async () => {
  const h = setup({ persons: threeNew(), writeAdd: true, maxAdd: 2 })
  const r = await h.run()
  assert.equal(r.outcome, 'ok')
  assert.deepEqual(h.writes(), [])
  assert.deepEqual(h.records().map((x) => [x.kind, x.reason]), [['left-out', 'cap'], ['left-out', 'cap'], ['left-out', 'cap']])
  assert.deepEqual(h.lines, ['MAILCHIMP CAP add=3 max=2', summary(h.lines)])
  assert.match(summary(h.lines), /adds=0 .*cap=3 /)
})

test('MIN_COHORT: cohort below → failed, not retryable, no Mailchimp requests', async () => {
  const h = setup({ persons: threeNew(), cfg: { minCohort: 5 }, writeAdd: true, writeArchive: true })
  const r = await h.run()
  assert.deepEqual(r, { outcome: 'failed', retryable: false, runId: RUN_ID })
  assert.deepEqual(h.lines, ['MAILCHIMP FAILED cohort 3 is below MIN_COHORT 5'])
  assert.deepEqual(h.events.filter((e) => !e.startsWith('VG') && !e.startsWith('write ')), [])
  assert.deepEqual(h.records(), [])
})

test('zero persons fails the run before Mailchimp', async () => {
  const h = setup({ persons: [], cfg: { minCohort: 1 }, writeAdd: true })
  const r = await h.run()
  assert.equal(r.outcome, 'failed')
  assert.equal(r.retryable, false)
  assert.deepEqual(h.lines, ['MAILCHIMP FAILED cohort 0 is below MIN_COHORT 1'])
})

test('snapshot is written before the first write, with list and members', async () => {
  const h = setup({ persons: [person(1, 'jane@example.org')], members: [member('old@example.org', 'unsubscribed', ago(31))], writeAdd: true, writeArchive: true })
  await h.run()
  const snap = `write out/audience-${RUN_ID}.json`
  const iSnap = h.events.indexOf(snap)
  const iWrite = h.events.findIndex((e) => /^(PUT|DELETE) /.test(e))
  assert.ok(iSnap >= 0 && iWrite > iSnap, h.events.join('\n'))
  const s = JSON.parse(h.files[`out/audience-${RUN_ID}.json`])
  assert.equal(s.taken_at, new Date(NOW).toISOString())
  assert.equal(s.list.id, 'list1')
  assert.deepEqual(s.members.map((m) => m.email_address), ['old@example.org'])
})

test('300 ms sleep between consecutive writes, none before the first', async () => {
  const h = setup({ persons: threeNew(), members: [member('u1@example.org', 'unsubscribed', ago(31))], writeAdd: true, writeArchive: true })
  await h.run()
  const seq = h.events.filter((e) => /^(PUT|DELETE) /.test(e) || e.startsWith('sleep'))
  assert.deepEqual(seq.map((e) => e.split(' ')[0]), ['DELETE', 'sleep', 'PUT', 'sleep', 'PUT', 'sleep', 'PUT'])
  assert.ok(seq.filter((e) => e.startsWith('sleep')).every((e) => e === 'sleep 300'))
})

test('abort with shutdown between two adds → stopped, first recorded, no FAILED line', async () => {
  const ac = new AbortController()
  // Fires in the 300 ms gap after the first add is confirmed, so the stop lands before the second PUT.
  const sleep = async () => { ac.abort('shutdown') }
  const h = setup({ persons: threeNew(), sleep, signal: ac.signal, writeAdd: true })
  const r = await h.run()
  assert.deepEqual(r, { outcome: 'stopped', retryable: false, runId: RUN_ID })
  assert.equal(h.writes().length, 1)
  assert.deepEqual(h.records().map((x) => [x.kind, x.email]), [['added', 'n1@example.org']])
  assert.deepEqual(h.lines, [])
})

test('abort with timeout → FAILED run timed out, retryable', async () => {
  const ac = new AbortController()
  const wrap = async (next, url, init) => {
    const res = await next(url, init)
    if (init.method === 'PUT') ac.abort('timeout')
    return res
  }
  const h = setup({ persons: threeNew(), wrap, signal: ac.signal, writeAdd: true })
  const r = await h.run()
  assert.deepEqual(r, { outcome: 'failed', retryable: true, runId: RUN_ID })
  assert.deepEqual(h.lines, ['MAILCHIMP FAILED run timed out'])
  assert.equal(h.records().length, 1)
})

test('thrown error → FAILED line; 401 is not retryable, 500 is; records still written', async () => {
  const failing = (status) => async (next, url, init) => {
    if (init.method === 'PUT') return { ok: false, status, statusText: 'x', headers: { get: () => null }, text: async () => JSON.stringify({ title: 'Nope', detail: 'no' }) }
    return next(url, init)
  }
  const h = setup({ persons: [person(1, 'jane@example.org'), person(2, '')], wrap: failing(401), writeAdd: true })
  const r = await h.run()
  assert.deepEqual(r, { outcome: 'failed', retryable: false, runId: RUN_ID })
  assert.equal(h.lines.length, 1)
  assert.match(h.lines[0], /^MAILCHIMP FAILED Mailchimp PUT .* 401/)
  assert.deepEqual(h.records().map((x) => x.reason), ['no-email'])

  const h2 = setup({ persons: [person(1, 'jane@example.org')], wrap: failing(500), writeAdd: true })
  const r2 = await h2.run()
  assert.deepEqual(r2, { outcome: 'failed', retryable: true, runId: RUN_ID })
})

// A read that never answers: only racing it against the signal can end the run.
const hang = () => new Promise(() => {})

test('timeout during classify in a dry run (read hangs) → FAILED run timed out, retryable, records written', { timeout: 2000 }, async () => {
  const ac = new AbortController()
  const target = subscriberHash('n2@example.org')
  const wrap = async (next, url, init) => {
    if (url.toString().endsWith(`/members/${target}`)) { ac.abort('timeout'); return hang() }
    return next(url, init)
  }
  const h = setup({ persons: [...threeNew(), person(4, '')], wrap, signal: ac.signal })
  const r = await h.run()
  assert.deepEqual(r, { outcome: 'failed', retryable: true, runId: RUN_ID })
  assert.deepEqual(h.lines, ['MAILCHIMP FAILED run timed out'])
  assert.deepEqual(h.records().map((x) => x.reason), ['no-email'])
  assert.ok(!h.events.includes(`GET /lists/list1/members/${subscriberHash('n3@example.org')}`))
})

test('shutdown during the list read (read hangs) → stopped, no line, records written', { timeout: 2000 }, async () => {
  const ac = new AbortController()
  const wrap = async (next, url, init) => {
    if (new URL(url).pathname.endsWith('/members')) { ac.abort('shutdown'); return hang() }
    return next(url, init)
  }
  const h = setup({ persons: threeNew(), wrap, signal: ac.signal, writeAdd: true })
  const r = await h.run()
  assert.deepEqual(r, { outcome: 'stopped', retryable: false, runId: RUN_ID })
  assert.deepEqual(h.lines, [])
  assert.deepEqual(h.records(), [])
  assert.deepEqual(h.writes(), [])
})

test('signal already aborted before the run → no reads at all', async () => {
  const ac = new AbortController()
  ac.abort('timeout')
  const h = setup({ persons: threeNew(), signal: ac.signal })
  const r = await h.run()
  assert.deepEqual(r, { outcome: 'failed', retryable: true, runId: RUN_ID })
  assert.deepEqual(h.events.filter((e) => !e.startsWith('write ')), [])
})

test('shutdown during an add read-back (read hangs) → stopped; the PUT is still recorded unconfirmed', { timeout: 2000 }, async () => {
  const ac = new AbortController()
  let put = false
  const wrap = async (next, url, init) => {
    if (init.method === 'PUT') { put = true; return next(url, init) }
    if (put && url.toString().endsWith(`/members/${subscriberHash('n1@example.org')}`)) { ac.abort('shutdown'); return hang() }
    return next(url, init)
  }
  const h = setup({ persons: threeNew(), wrap, signal: ac.signal, writeAdd: true })
  const r = await h.run()
  assert.equal(r.outcome, 'stopped')
  assert.equal(h.writes().length, 1)
  assert.deepEqual(h.records().map((x) => [x.kind, x.reason, x.email, x.status]), [['left-out', 'write-unconfirmed', 'n1@example.org', null]])
})

// Per-contact refusals (4xx) are recorded and the run goes on; 401, 429/5xx and network errors fail it.
const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, statusText: '', headers: { get: () => null }, text: async () => JSON.stringify(body) })

test('add: Mailchimp refuses the second of three (400) → rejected with status and detail, the others added, run ok', async () => {
  const persons = [person(1, 'n1@example.org'), person(2, 'jane.doe@invalid.example'), person(3, 'n3@example.org')]
  const h = setup({ persons, writeAdd: true })
  const r = await h.run()
  assert.deepEqual(r, { outcome: 'ok', retryable: false, runId: RUN_ID })
  assert.equal(h.find('n1@example.org').status, 'subscribed')
  assert.equal(h.find('n3@example.org').status, 'subscribed')
  assert.equal(h.find('jane.doe@invalid.example'), undefined)
  const recs = h.records()
  assert.deepEqual(recs.map((x) => [x.kind, x.reason ?? null, x.email]), [
    ['added', null, 'n1@example.org'],
    ['left-out', 'rejected', 'jane.doe@invalid.example'],
    ['added', null, 'n3@example.org'],
  ])
  const rej = recs[1]
  assert.deepEqual(Object.keys(rej).sort(), ['at', 'detail', 'email', 'hash', 'kind', 'personIds', 'reason', 'status'])
  assert.equal(rej.status, 400)
  assert.deepEqual(rej.personIds, ['2'])
  assert.equal(rej.hash, subscriberHash('jane.doe@invalid.example'))
  assert.match(rej.detail, /looks fake or invalid/)
  assert.deepEqual(h.lines, [summary(h.lines)])
  assert.match(summary(h.lines), /^MAILCHIMP OK adds=2 archives=0 subscribed=0 left-out=1 \(.* other=1\) /)
  // The 300 ms gap still applies around the refused write.
  const seq = h.events.filter((e) => e.startsWith('PUT') || e.startsWith('sleep')).map((e) => e.split(' ')[0])
  assert.deepEqual(seq, ['PUT', 'sleep', 'PUT', 'sleep', 'PUT'])
})

test('add: a refusal detail longer than 200 characters is cut to 200', async () => {
  const wrap = async (next, url, init) => (init.method === 'PUT' ? answer(400, { title: 'Invalid Resource', detail: 'x'.repeat(500) }) : next(url, init))
  const h = setup({ persons: [person(1, 'n1@example.org')], wrap, writeAdd: true })
  assert.equal((await h.run()).outcome, 'ok')
  const [rec] = h.records()
  assert.equal(rec.reason, 'rejected')
  assert.equal(rec.detail.length, 200)
})

test('add: PUT lands but the read-back is refused (4xx) → write-unconfirmed, status null, run goes on', async () => {
  const target = subscriberHash('n1@example.org')
  let put = false
  const wrap = async (next, url, init) => {
    if (init.method === 'PUT') { put = true; return next(url, init) }
    if (put && url.toString().endsWith(`/members/${target}`)) return answer(400, { title: 'Bad Request', detail: 'nope' })
    return next(url, init)
  }
  const h = setup({ persons: threeNew(), wrap, writeAdd: true })
  const r = await h.run()
  assert.equal(r.outcome, 'ok')
  const recs = h.records()
  assert.deepEqual(recs.map((x) => [x.kind, x.reason ?? null, x.email, x.status]), [
    ['left-out', 'write-unconfirmed', 'n1@example.org', null],
    ['added', null, 'n2@example.org', 'subscribed'],
    ['added', null, 'n3@example.org', 'subscribed'],
  ])
  assert.match(summary(h.lines), /adds=2 .*other=1\) /)
})

test('add: a 500 that exhausts its retries still fails the run, retryable; no later PUT', async () => {
  const wrap = async (next, url, init) => (init.method === 'PUT' ? answer(500, { title: 'Server Error', detail: 'down' }) : next(url, init))
  const h = setup({ persons: threeNew(), wrap, writeAdd: true })
  const r = await h.run()
  assert.deepEqual(r, { outcome: 'failed', retryable: true, runId: RUN_ID })
  assert.equal(h.writes().length, 4) // one PUT, tried four times
  assert.match(h.lines[0], /^MAILCHIMP FAILED Mailchimp PUT .* 500/)
  assert.deepEqual(h.records(), [])
})

test('add: 429 and network errors that exhaust retries fail the run, retryable', async () => {
  const w429 = async (next, url, init) => (init.method === 'PUT' ? answer(429, { title: 'Too Many Requests', detail: 'slow' }) : next(url, init))
  const h = setup({ persons: threeNew(), wrap: w429, writeAdd: true })
  assert.deepEqual(await h.run(), { outcome: 'failed', retryable: true, runId: RUN_ID })
  const wNet = async (next, url, init) => { if (init.method === 'PUT') throw new TypeError('fetch failed'); return next(url, init) }
  const h2 = setup({ persons: threeNew(), wrap: wNet, writeAdd: true })
  assert.deepEqual(await h2.run(), { outcome: 'failed', retryable: true, runId: RUN_ID })
  assert.equal(h2.find('n2@example.org'), undefined)
})

test('add: PUT lands but the read-back fails with a 500 → recorded write-unconfirmed, then the run fails', async () => {
  const target = subscriberHash('n1@example.org')
  let put = false
  const wrap = async (next, url, init) => {
    if (init.method === 'PUT') { put = true; return next(url, init) }
    if (put && url.toString().endsWith(`/members/${target}`)) return answer(503, { title: 'Unavailable', detail: 'down' })
    return next(url, init)
  }
  const h = setup({ persons: threeNew(), wrap, writeAdd: true })
  const r = await h.run()
  assert.deepEqual(r, { outcome: 'failed', retryable: true, runId: RUN_ID })
  assert.deepEqual(h.records().map((x) => [x.kind, x.reason, x.email, x.status]), [['left-out', 'write-unconfirmed', 'n1@example.org', null]])
  assert.equal(h.writes().length, 1)
})

test('archive: a 400 on DELETE → archive-skipped with status and detail; the next archive still runs', async () => {
  const first = subscriberHash('a@example.org')
  const wrap = async (next, url, init) => {
    if (init.method === 'DELETE' && url.toString().endsWith(`/members/${first}`)) return answer(400, { title: 'Invalid Resource', detail: 'cannot archive' })
    return next(url, init)
  }
  const h = setup({ persons: [person(1, 'jane@example.org')], members: threeOld(), wrap, writeArchive: true })
  const r = await h.run()
  assert.equal(r.outcome, 'ok')
  assert.equal(h.find('a@example.org').status, 'unsubscribed')
  assert.equal(h.find('b@example.org').status, 'archived')
  assert.equal(h.find('c@example.org').status, 'archived')
  const recs = h.records()
  assert.deepEqual(recs.map((x) => [x.kind, x.email]), [['archive-skipped', 'a@example.org'], ['archived', 'b@example.org'], ['archived', 'c@example.org']])
  assert.equal(recs[0].status, 400)
  assert.equal(recs[0].reason, 'rejected')
  assert.equal(recs[0].detail, 'cannot archive')
  assert.match(summary(h.lines), /archives=2 /)
})

test('archive: a 400 on the read-back after DELETE → archive-skipped with that status; run goes on', async () => {
  const first = subscriberHash('a@example.org')
  let deleted = false
  const wrap = async (next, url, init) => {
    if (init.method === 'DELETE' && url.toString().endsWith(`/members/${first}`)) { deleted = true; return next(url, init) }
    if (deleted && (init.method ?? 'GET') === 'GET' && url.toString().endsWith(`/members/${first}`)) return answer(400, { title: 'Bad Request', detail: 'nope' })
    return next(url, init)
  }
  const h = setup({ persons: [person(1, 'jane@example.org')], members: threeOld(), wrap, writeArchive: true })
  assert.equal((await h.run()).outcome, 'ok')
  const recs = h.records()
  assert.deepEqual(recs.map((x) => [x.kind, x.email, x.status]), [['archive-skipped', 'a@example.org', 400], ['archived', 'b@example.org', 'archived'], ['archived', 'c@example.org', 'archived']])
})

test('archive: a 500 that exhausts retries on DELETE fails the run, retryable', async () => {
  const wrap = async (next, url, init) => (init.method === 'DELETE' ? answer(500, { title: 'Server Error', detail: 'down' }) : next(url, init))
  const h = setup({ persons: [person(1, 'jane@example.org')], members: threeOld(), wrap, writeArchive: true })
  assert.deepEqual(await h.run(), { outcome: 'failed', retryable: true, runId: RUN_ID })
  assert.equal(h.find('b@example.org').status, 'unsubscribed')
})

test('R10: an audience whose name differs from MAILCHIMP_LIST_NAME → failed, not retryable, no snapshot, no writes', async () => {
  const h = setup({ persons: threeNew(), members: threeOld(), cfg: { mailchimp: { listId: 'list1', listName: 'Expected Audience', mock: null } }, writeAdd: true, writeArchive: true })
  const r = await h.run()
  assert.deepEqual(r, { outcome: 'failed', retryable: false, runId: RUN_ID })
  assert.deepEqual(h.lines, ['MAILCHIMP FAILED Mailchimp audience name is "Test List", expected "Expected Audience"'])
  assert.deepEqual(h.writes(), [])
  assert.equal(h.files[`out/audience-${RUN_ID}.json`], undefined)
  assert.ok(!h.events.some((e) => e.endsWith('/members')), 'members not read')
})

test('R10/R4: a mock with an empty name skips the check; an empty name without a mock still refuses', async () => {
  const h = setup({ persons: threeNew(), cfg: { mailchimp: { listId: 'list1', listName: '', mock: 'state.json' } }, writeAdd: true })
  assert.equal((await h.run()).outcome, 'ok')
  const h2 = setup({ persons: threeNew(), cfg: { mailchimp: { listId: 'list1', listName: '', mock: null } }, writeAdd: true })
  assert.deepEqual(await h2.run(), { outcome: 'failed', retryable: false, runId: RUN_ID })
  assert.deepEqual(h2.writes(), [])
})

test('403 on an add (key or account refused) → FAILED, not retryable, no further writes', async () => {
  let puts = 0
  const wrap = async (next, url, init) => {
    if (init.method === 'PUT') { puts++; return answer(403, { title: 'Forbidden', detail: 'no access' }) }
    return next(url, init)
  }
  const h = setup({ persons: threeNew(), wrap, writeAdd: true })
  const r = await h.run()
  assert.deepEqual(r, { outcome: 'failed', retryable: false, runId: RUN_ID })
  assert.equal(puts, 1)
  assert.equal(h.lines.length, 1)
  assert.match(h.lines[0], /^MAILCHIMP FAILED Mailchimp PUT .* 403/)
  assert.ok(!h.records().some((x) => x.reason === 'rejected'))
})

test('403 on an archive → FAILED, not retryable, not recorded as archive-skipped', async () => {
  let deletes = 0
  const wrap = async (next, url, init) => {
    if (init.method === 'DELETE') { deletes++; return answer(403, { title: 'Forbidden', detail: 'no access' }) }
    return next(url, init)
  }
  const h = setup({ persons: [person(1, 'jane@example.org')], members: threeOld(), wrap, writeArchive: true })
  const r = await h.run()
  assert.deepEqual(r, { outcome: 'failed', retryable: false, runId: RUN_ID })
  assert.equal(deletes, 1)
  assert.match(h.lines[0], /^MAILCHIMP FAILED Mailchimp DELETE .* 403/)
  assert.ok(!h.records().some((x) => x.reason === 'archive-skipped'))
})
