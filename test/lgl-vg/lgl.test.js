import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLglClient } from '../../src/lgl-vg/lgl.js'

// A fake fetch that serves a queue of canned responses and records each call.
function fakeFetch(responses, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url: new URL(url), init })
    const r = responses.shift()
    if (!r) return new Response('queue empty', { status: 500 })
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers ?? {} })
  }
}
const recordSleeps = (sleeps) => async (ms) => { sleeps.push(ms) }
const noSleep = async () => {}
const items = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ id: from + i }))

test('sends Basic auth with the key as user and an empty password', async () => {
  const calls = []
  const lgl = createLglClient({
    apiKey: 'k',
    sleep: noSleep,
    fetchImpl: fakeFetch([{ body: { items: [], total_items: 0 } }], calls),
  })
  await lgl.pullGifts()
  assert.equal(calls[0].init.headers.Authorization, 'Basic ' + Buffer.from('k:').toString('base64'))
  assert.equal(calls[0].init.method, 'GET')
})

test('requires an api key', () => {
  assert.throws(() => createLglClient({ apiKey: '' }), /LGL_API_KEY/)
})

test('pullConstituents pages by 1000 and asks for the three sub-lists', async () => {
  const calls = []
  const lgl = createLglClient({
    apiKey: 'k',
    sleep: noSleep,
    fetchImpl: fakeFetch(
      [
        { body: { items: items(1000), total_items: 1001 } },
        { body: { items: items(1, 1000), total_items: 1001 } },
      ],
      calls,
    ),
  })
  const all = await lgl.pullConstituents()
  assert.equal(all.length, 1001)
  assert.equal(calls.length, 2)
  const first = calls[0].url
  assert.equal(first.pathname, '/api/v1/constituents/search')
  assert.equal(first.searchParams.get('limit'), '1000')
  assert.equal(first.searchParams.get('offset'), '0')
  assert.equal(first.searchParams.get('expand'), 'email_addresses,street_addresses,phone_numbers')
  assert.equal(calls[1].url.searchParams.get('offset'), '1000')
})

test('throws when the pages add up to fewer than total_items', async () => {
  const lgl = createLglClient({
    apiKey: 'k',
    sleep: noSleep,
    fetchImpl: fakeFetch([
      { body: { items: items(3), total_items: 5 } },
      { body: { items: [], total_items: 5 } },
    ]),
  })
  await assert.rejects(lgl.pullGifts(), /Incomplete read/)
})

test('waits out Retry-After on 429', async () => {
  const sleeps = []
  const lgl = createLglClient({
    apiKey: 'k',
    sleep: recordSleeps(sleeps),
    fetchImpl: fakeFetch([
      { status: 429, headers: { 'retry-after': '7' } },
      { body: { items: items(2), total_items: 2 } },
    ]),
  })
  assert.equal((await lgl.pullGifts()).length, 2)
  assert.deepEqual(sleeps, [7000])
})

test('with no Retry-After, backs off 30, 60, 120, 240 seconds, then fails', async () => {
  const sleeps = []
  const responses = Array.from({ length: 5 }, () => ({ status: 503 }))
  const lgl = createLglClient({ apiKey: 'k', sleep: recordSleeps(sleeps), fetchImpl: fakeFetch(responses) })
  await assert.rejects(lgl.pullGifts(), /503/)
  assert.deepEqual(sleeps, [30000, 60000, 120000, 240000])
})

test('a 4xx other than 429 fails at once with the status and path', async () => {
  const sleeps = []
  const lgl = createLglClient({
    apiKey: 'k',
    sleep: recordSleeps(sleeps),
    fetchImpl: fakeFetch([{ status: 403, body: { error: 'no' } }]),
  })
  await assert.rejects(lgl.pullGifts(), /LGL GET \/gifts\/search.*403/)
  assert.deepEqual(sleeps, [])
})

test('a 404 is an error, not an empty answer', async () => {
  const lgl = createLglClient({ apiKey: 'k', sleep: noSleep, fetchImpl: fakeFetch([{ status: 404 }, { status: 404 }]) })
  await assert.rejects(lgl.pullGifts(), /404/)
  await assert.rejects(lgl.pullConstituents(), /404/)
})
