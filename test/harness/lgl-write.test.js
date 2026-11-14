import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLglWriter, HARNESS_MARKER } from '../../harness/lgl-write.js'

// A fake fetch that serves a queue of canned responses and records each call.
function fakeFetch(responses, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url: new URL(url), init, body: init.body === undefined ? undefined : JSON.parse(init.body) })
    const r = responses.shift()
    if (!r) return new Response('queue empty', { status: 500 })
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers ?? {} })
  }
}
const recordSleeps = (sleeps) => async (ms) => { sleeps.push(ms) }
const noSleep = async () => {}

test('the marker is vg-sync-harness', () => {
  assert.equal(HARNESS_MARKER, 'vg-sync-harness')
})

test('requires an api key', () => {
  assert.throws(() => createLglWriter({ apiKey: '' }), /LGL_API_KEY/)
})

test('waits out Retry-After on 429, then retries', async () => {
  const sleeps = []
  const calls = []
  const lgl = createLglWriter({
    apiKey: 'k',
    sleep: recordSleeps(sleeps),
    fetchImpl: fakeFetch([{ status: 429, headers: { 'retry-after': '7' } }, { body: { id: 5 } }], calls),
  })
  assert.deepEqual(await lgl.request('POST', '/constituents', { first_name: 'Jane' }), { id: 5 })
  assert.deepEqual(sleeps, [7000])
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1].body, { first_name: 'Jane' })
})

test('a 500 four times then 200 succeeds after backing off 30, 60, 120, 240 seconds', async () => {
  const sleeps = []
  const responses = [...Array.from({ length: 4 }, () => ({ status: 500 })), { body: { ok: true } }]
  const lgl = createLglWriter({ apiKey: 'k', sleep: recordSleeps(sleeps), fetchImpl: fakeFetch(responses) })
  assert.deepEqual(await lgl.request('PATCH', '/constituents/3', { last_name: 'Doe' }), { ok: true })
  assert.deepEqual(sleeps, [30000, 60000, 120000, 240000])
})

test('five 5xx answers fail with the last status', async () => {
  const sleeps = []
  const responses = Array.from({ length: 5 }, () => ({ status: 503 }))
  const lgl = createLglWriter({ apiKey: 'k', sleep: recordSleeps(sleeps), fetchImpl: fakeFetch(responses) })
  await assert.rejects(lgl.request('GET', '/funds'), /LGL GET \/funds → 503/)
  assert.equal(sleeps.length, 4)
})

test('a 404 throws at once with method, path and status', async () => {
  const sleeps = []
  const lgl = createLglWriter({
    apiKey: 'k',
    sleep: recordSleeps(sleeps),
    fetchImpl: fakeFetch([{ status: 404, body: { error: 'Not found' } }]),
  })
  await assert.rejects(lgl.deleteConstituent(9), /^Error: LGL DELETE \/constituents\/9 → 404: /)
  assert.deepEqual(sleeps, [])
})

test('sends Basic auth with the key as user, and JSON', async () => {
  const calls = []
  const lgl = createLglWriter({ apiKey: 'k', sleep: noSleep, fetchImpl: fakeFetch([{ body: {} }], calls) })
  await lgl.request('DELETE', '/constituents/4')
  assert.equal(calls[0].init.method, 'DELETE')
  assert.equal(calls[0].init.headers.Authorization, 'Basic ' + Buffer.from('k:').toString('base64'))
  assert.equal(calls[0].url.href, 'https://api.littlegreenlight.com/api/v1/constituents/4')
  assert.equal(calls[0].init.body, undefined)
})

test('createConstituent sends the marker on every create, whatever the body says', async () => {
  const calls = []
  const lgl = createLglWriter({
    apiKey: 'k',
    sleep: noSleep,
    fetchImpl: fakeFetch([{ body: { id: 11, first_name: 'Jane' } }, { body: { id: 12 } }], calls),
  })
  assert.deepEqual(await lgl.createConstituent({ first_name: 'Jane', last_name: 'Doe' }), { id: 11 })
  await lgl.createConstituent({ first_name: 'John', last_name: 'Doe', external_constituent_id: 'other' })
  for (const c of calls) {
    assert.equal(c.init.method, 'POST')
    assert.equal(c.url.pathname, '/api/v1/constituents')
    assert.equal(c.body.external_constituent_id, HARNESS_MARKER)
  }
  assert.equal(calls[0].body.first_name, 'Jane')
})

test('updateConstituent PATCHes the body as given', async () => {
  const calls = []
  const lgl = createLglWriter({ apiKey: 'k', sleep: noSleep, fetchImpl: fakeFetch([{ body: { id: 3 } }], calls) })
  await lgl.updateConstituent(3, { is_deceased: true, deceased_date: '2026-01-15' })
  assert.equal(calls[0].init.method, 'PATCH')
  assert.equal(calls[0].url.pathname, '/api/v1/constituents/3')
  assert.deepEqual(calls[0].body, { is_deceased: true, deceased_date: '2026-01-15' })
})

test('entries: add, update and list by kind; other kinds are refused', async () => {
  const calls = []
  const lgl = createLglWriter({
    apiKey: 'k',
    sleep: noSleep,
    fetchImpl: fakeFetch(
      [{ body: { id: 21 } }, { body: { id: 21 } }, { body: { items: [{ id: 21 }], total_items: 1 } }],
      calls,
    ),
  })
  assert.deepEqual(await lgl.addEntry(3, 'phone_numbers', { number: '401-555-0100' }), { id: 21 })
  await lgl.updateEntry(3, 'phone_numbers', 21, { is_preferred: true })
  assert.deepEqual(await lgl.listEntries(3, 'phone_numbers'), [{ id: 21 }])
  assert.deepEqual(
    calls.map((c) => `${c.init.method} ${c.url.pathname}`),
    ['POST /api/v1/constituents/3/phone_numbers', 'PATCH /api/v1/phone_numbers/21', 'GET /api/v1/constituents/3/phone_numbers'],
  )
  await assert.rejects(lgl.addEntry(3, 'web_addresses', {}), /kind/)
})

test('addGift posts to the constituent and returns the id', async () => {
  const calls = []
  const lgl = createLglWriter({ apiKey: 'k', sleep: noSleep, fetchImpl: fakeFetch([{ body: { id: 31 } }], calls) })
  const body = { gift_type_id: 1, fund_id: 2, payment_type_id: 3, received_amount: 25, received_date: '2026-01-10' }
  assert.deepEqual(await lgl.addGift(3, body), { id: 31 })
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].url.pathname, '/api/v1/constituents/3/gifts')
  assert.deepEqual(calls[0].body, body)
})

test('getConstituent returns the record with its three entry lists', async () => {
  const calls = []
  const lgl = createLglWriter({
    apiKey: 'k',
    sleep: noSleep,
    fetchImpl: fakeFetch(
      [
        { body: { id: 3, first_name: 'Jane' } },
        { body: { items: [{ id: 1 }], total_items: 1 } },
        { body: { items: [], total_items: 0 } },
        { body: { items: [{ id: 2 }], total_items: 1 } },
      ],
      calls,
    ),
  })
  const c = await lgl.getConstituent(3)
  assert.equal(c.first_name, 'Jane')
  assert.deepEqual(c.street_addresses, [{ id: 1 }])
  assert.deepEqual(c.email_addresses, [])
  assert.deepEqual(c.phone_numbers, [{ id: 2 }])
  assert.ok(calls.every((c) => c.init.method === 'GET'))
})

test('listHarnessConstituents searches by the marker and keeps only exact matches', async () => {
  const calls = []
  const lgl = createLglWriter({
    apiKey: 'k',
    sleep: noSleep,
    fetchImpl: fakeFetch(
      [
        {
          body: {
            total_items: 2,
            items: [
              { id: 1, external_constituent_id: HARNESS_MARKER },
              { id: 2, external_constituent_id: 'someone-else' },
            ],
          },
        },
      ],
      calls,
    ),
  })
  assert.deepEqual((await lgl.listHarnessConstituents()).map((c) => c.id), [1])
  const u = calls[0].url
  assert.equal(u.pathname, '/api/v1/constituents/search')
  assert.equal(u.searchParams.get('q[]'), `external_id=${HARNESS_MARKER}`)
  assert.equal(u.searchParams.get('limit'), '1000')
})

test('countConstituents reads total_items from a one-item search', async () => {
  const calls = []
  const lgl = createLglWriter({
    apiKey: 'k',
    sleep: noSleep,
    fetchImpl: fakeFetch([{ body: { total_items: 42, items: [{ id: 1 }] } }], calls),
  })
  assert.equal(await lgl.countConstituents(), 42)
  assert.equal(calls[0].url.searchParams.get('limit'), '1')
})
