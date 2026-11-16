import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLglClient, PROBE_TIMEOUT_MS } from '../../src/lgl-vg/lgl.js'

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

const hangingFetch = () => (url, init = {}) =>
  new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason))
  })

test('a rejected fetch is retried with backoff', async () => {
  let n = 0
  const sleeps = []
  const lgl = createLglClient({
    apiKey: 'k',
    sleep: recordSleeps(sleeps),
    fetchImpl: async () => {
      if (++n <= 2) throw new TypeError('fetch failed')
      return new Response(JSON.stringify({ items: [], total_items: 0 }))
    },
  })
  assert.deepEqual(await lgl.pullGifts(), [])
  assert.deepEqual(sleeps, [30000, 60000])
})

test('a fetch that rejects every time fails after five tries', async () => {
  let n = 0
  const lgl = createLglClient({
    apiKey: 'k',
    sleep: noSleep,
    fetchImpl: async () => { n++; throw new TypeError('fetch failed') },
  })
  await assert.rejects(lgl.pullGifts(), /fetch failed/)
  assert.equal(n, 5)
})

test('a request past the timeout counts as a network failure and is retried', async () => {
  let n = 0
  const hang = hangingFetch()
  const lgl = createLglClient({
    apiKey: 'k',
    sleep: noSleep,
    timeoutMs: 20,
    fetchImpl: async (url, init) => {
      if (++n === 1) return hang(url, init)
      return new Response(JSON.stringify({ items: [], total_items: 0 }))
    },
  })
  assert.deepEqual(await lgl.pullGifts(), [])
  assert.equal(n, 2)
})

test('a request that times out every time says so', async () => {
  const lgl = createLglClient({ apiKey: 'k', sleep: noSleep, timeoutMs: 5, fetchImpl: hangingFetch() })
  await assert.rejects(lgl.pullGifts(), /timed out/)
})

test('probe asks for one constituent', async () => {
  const calls = []
  const lgl = createLglClient({
    apiKey: 'k',
    sleep: noSleep,
    fetchImpl: fakeFetch([{ body: { items: [], total_items: 0 } }], calls),
  })
  assert.deepEqual(await lgl.probe(), { rateLimited: false })
  assert.equal(calls[0].url.pathname, '/api/v1/constituents.json')
  assert.equal(calls[0].url.searchParams.get('limit'), '1')
})

test('probe takes a 429 as LGL reached (it answered), at once, without waiting', async () => {
  const sleeps = []
  const calls = []
  const lgl = createLglClient({
    apiKey: 'k',
    sleep: recordSleeps(sleeps),
    fetchImpl: fakeFetch([{ status: 429, headers: { 'retry-after': '300' } }, { body: { items: [], total_items: 0 } }], calls),
  })
  assert.deepEqual(await lgl.probe(), { rateLimited: true })
  assert.equal(calls.length, 1)
  assert.deepEqual(sleeps, [])
})

test('probe makes one attempt: a rejected fetch fails at once', async () => {
  let n = 0
  const sleeps = []
  const lgl = createLglClient({
    apiKey: 'k',
    sleep: recordSleeps(sleeps),
    fetchImpl: async () => { n++; throw new TypeError('fetch failed') },
  })
  await assert.rejects(lgl.probe(), /fetch failed/)
  assert.equal(n, 1)
  assert.deepEqual(sleeps, [])
})

test('probe makes one attempt: a 503 fails at once', async () => {
  const sleeps = []
  const calls = []
  const lgl = createLglClient({
    apiKey: 'k',
    sleep: recordSleeps(sleeps),
    fetchImpl: fakeFetch([{ status: 503 }, { body: { items: [], total_items: 0 } }], calls),
  })
  await assert.rejects(lgl.probe(), (err) => err.status === 503 && !err.final)
  assert.equal(calls.length, 1)
  assert.deepEqual(sleeps, [])
})

test('probe takes its timeout from the caller', async () => {
  const hang = hangingFetch()
  const lgl = createLglClient({ apiKey: 'k', sleep: noSleep, timeoutMs: 600_000, fetchImpl: hang })
  await assert.rejects(lgl.probe({ timeoutMs: 30 }), /timed out after 0.03 s/)
})

test('probe has its own short timeout, 15 seconds by default', async () => {
  assert.equal(PROBE_TIMEOUT_MS, 15_000)
  let n = 0
  const hang = hangingFetch()
  const lgl = createLglClient({
    apiKey: 'k', sleep: noSleep, timeoutMs: 600_000, probeTimeoutMs: 20,
    fetchImpl: (url, init) => { n++; return hang(url, init) },
  })
  await assert.rejects(lgl.probe(), /timed out after 0.02 s/)
  assert.equal(n, 1)
})

test('a 401 (a bad API key) is final; a 403 or a 404 is not', async () => {
  const lgl = createLglClient({ apiKey: 'k', sleep: noSleep, fetchImpl: fakeFetch([{ status: 401 }]) })
  await assert.rejects(lgl.pullGifts(), (err) => err.final === true && err.status === 401)
  for (const status of [403, 404]) {
    const other = createLglClient({ apiKey: 'k', sleep: noSleep, fetchImpl: fakeFetch([{ status }]) })
    await assert.rejects(other.pullGifts(), (err) => !err.final && err.status === status)
  }
})

test('getConstituent sends no query string', async () => {
  const calls = []
  const lgl = createLglClient({ apiKey: 'k', sleep: noSleep, fetchImpl: fakeFetch([{ body: { id: 42 } }], calls) })
  assert.deepEqual(await lgl.getConstituent(42), { id: 42 })
  assert.ok(calls[0].url.href.endsWith('/constituents/42.json'))
  assert.equal(calls[0].url.search, '')
})

test('attempts: 1 does not retry a 429', async () => {
  const calls = []
  const lgl = createLglClient({ apiKey: 'k', sleep: noSleep, fetchImpl: fakeFetch([{ status: 429 }, { body: { id: 42 } }], calls) })
  await assert.rejects(lgl.getConstituent(42, { attempts: 1 }), (e) => e.status === 429)
  assert.equal(calls.length, 1)
})

test('constituentGifts pages the constituent gifts path', async () => {
  const calls = []
  const lgl = createLglClient({
    apiKey: 'k', sleep: noSleep,
    fetchImpl: fakeFetch([{ body: { items: items(2), total_items: 2 } }], calls),
  })
  assert.equal((await lgl.constituentGifts(7)).length, 2)
  assert.equal(calls[0].url.pathname, '/api/v1/constituents/7/gifts.json')
  assert.equal(calls[0].url.searchParams.get('limit'), '1000')
})

test('constituentsSince sends updated_from and the expands', async () => {
  const calls = []
  const lgl = createLglClient({
    apiKey: 'k', sleep: noSleep,
    fetchImpl: fakeFetch([{ body: { items: items(1), total_items: 1 } }], calls),
  })
  await lgl.constituentsSince('2026-11-15T10:00:00Z')
  assert.equal(calls[0].url.pathname, '/api/v1/constituents/search')
  assert.equal(calls[0].url.searchParams.get('q[]'), 'updated_from=2026-11-15T10:00:00Z')
  assert.equal(calls[0].url.searchParams.get('expand'), 'email_addresses,street_addresses,phone_numbers')
})

test('giftsSince sends a bare date, and passes attempts through the pages', async () => {
  const calls = []
  const lgl = createLglClient({
    apiKey: 'k', sleep: noSleep,
    fetchImpl: fakeFetch([{ status: 429 }, { body: { items: items(1), total_items: 1 } }], calls),
  })
  await assert.rejects(lgl.giftsSince('2026-11-15', { attempts: 1 }), (e) => e.status === 429)
  const lgl2 = createLglClient({
    apiKey: 'k', sleep: noSleep,
    fetchImpl: fakeFetch([{ body: { items: items(1), total_items: 1 } }], calls),
  })
  await lgl2.giftsSince('2026-11-15')
  const u = calls.at(-1).url
  assert.equal(u.pathname, '/api/v1/gifts/search')
  assert.equal(u.searchParams.get('q[]'), 'updated_from=2026-11-15')
})

// --- writes (step 7) ---
const writeClient = (fetchImpl, sleeps = []) => createLglClient({ apiKey: 'k', sleep: recordSleeps(sleeps), fetchImpl })
const throwingOnce = (then, calls) => {
  let first = true
  return async (url, init = {}) => {
    calls.push({ url: new URL(url), init })
    if (first) {
      first = false
      throw Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') })
    }
    return new Response(JSON.stringify(then), { status: 200 })
  }
}

test('a POST that fails on the network is not retried', async () => {
  const calls = []
  const sleeps = []
  const lgl = writeClient(async (url, init) => {
    calls.push({ url, init })
    throw new TypeError('fetch failed')
  }, sleeps)
  await assert.rejects(lgl.addEntry(7, 'email_addresses', { address: 'jane@example.org' }), /fetch failed/)
  assert.equal(calls.length, 1)
  assert.deepEqual(sleeps, [])
})

test('a POST that times out is not retried', async () => {
  const calls = []
  const sleeps = []
  const lgl = writeClient(async (url, init) => {
    calls.push({ url, init })
    throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
  }, sleeps)
  await assert.rejects(lgl.addEntry(7, 'phone_numbers', { number: '401-555-0100' }), /POST .* timed out/)
  assert.equal(calls.length, 1)
  assert.deepEqual(sleeps, [])
})

test('a POST answered 429 waits and is retried', async () => {
  const calls = []
  const sleeps = []
  const lgl = writeClient(
    fakeFetch([{ status: 429, headers: { 'retry-after': '1' } }, { body: { id: 55, not_current: false, is_preferred: true } }], calls),
    sleeps,
  )
  const made = await lgl.addEntry(7, 'email_addresses', { address: 'jane@example.org' })
  assert.equal(made.id, 55)
  assert.equal(calls.length, 2)
  assert.deepEqual(sleeps, [1000])
})

test('a PATCH that fails on the network is retried like a read', async () => {
  const calls = []
  const sleeps = []
  const lgl = writeClient(throwingOnce({ id: 9, not_current: true, is_preferred: false }, calls), sleeps)
  const got = await lgl.patchEntry('email_addresses', 9, { not_current: true })
  assert.equal(got.not_current, true)
  assert.equal(calls.length, 2)
  assert.deepEqual(sleeps, [30_000])
})

test('a write answered 422 throws with status 422, not retried', async () => {
  const calls = []
  const lgl = writeClient(fakeFetch([{ status: 422, body: { error: 'bad' } }], calls))
  await assert.rejects(lgl.patchConstituent(7, { first_name: 'Jane' }), (err) => {
    assert.equal(err.status, 422)
    assert.notEqual(err.final, true)
    assert.match(err.message, /LGL PATCH \/constituents\/7 → 422/)
    return true
  })
  assert.equal(calls.length, 1)
})

test('a write answered 401 is final', async () => {
  const lgl = writeClient(fakeFetch([{ status: 401, body: {} }]))
  await assert.rejects(lgl.patchConstituent(7, {}), (err) => err.status === 401 && err.final === true)
})

test('getConstituentFull reads the record and its three lists', async () => {
  const calls = []
  const lgl = writeClient(
    fakeFetch(
      [
        { body: { id: 7, first_name: 'Jane' } },
        { body: { items: [{ id: 1 }], total_items: 1 } },
        { body: { items: [{ id: 2 }, { id: 3 }], total_items: 2 } },
        { body: { items: [], total_items: 0 } },
      ],
      calls,
    ),
  )
  const c = await lgl.getConstituentFull(7)
  assert.equal(calls.length, 4)
  assert.ok(calls.every((x) => x.init.method === 'GET'))
  assert.equal(calls[0].url.pathname, '/api/v1/constituents/7.json')
  assert.equal(calls[0].url.search, '')
  assert.deepEqual(calls.slice(1).map((x) => x.url.pathname), [
    '/api/v1/constituents/7/street_addresses',
    '/api/v1/constituents/7/email_addresses',
    '/api/v1/constituents/7/phone_numbers',
  ])
  assert.ok(calls.slice(1).every((x) => x.url.searchParams.get('limit') === '100'))
  assert.equal(c.first_name, 'Jane')
  assert.deepEqual(c.street_addresses, [{ id: 1 }])
  assert.deepEqual(c.email_addresses, [{ id: 2 }, { id: 3 }])
  assert.deepEqual(c.phone_numbers, [])
})

test('an unknown entry kind is refused before any request', async () => {
  const calls = []
  const lgl = writeClient(fakeFetch([], calls))
  assert.throws(() => lgl.addEntry(7, 'gifts', {}), /Unknown entry kind/)
  assert.throws(() => lgl.patchEntry('gifts', 1, {}), /Unknown entry kind/)
  assert.throws(() => lgl.listEntries(7, 'gifts'), /Unknown entry kind/)
  assert.equal(calls.length, 0)
})

test('writes send JSON with the auth header', async () => {
  const calls = []
  const lgl = writeClient(fakeFetch([{ body: { id: 1 } }, { body: { id: 7 } }, { body: { id: 9 } }], calls))
  await lgl.addEntry(7, 'email_addresses', { address: 'jane@example.org' })
  await lgl.patchConstituent(7, { first_name: 'Jane' })
  await lgl.patchEntry('phone_numbers', 9, { not_current: true })
  const [post, patchC, patchE] = calls
  assert.equal(post.init.method, 'POST')
  assert.equal(post.url.pathname, '/api/v1/constituents/7/email_addresses')
  assert.equal(post.init.body, JSON.stringify({ address: 'jane@example.org' }))
  assert.equal(patchC.init.method, 'PATCH')
  assert.equal(patchC.url.pathname, '/api/v1/constituents/7')
  assert.equal(patchE.init.method, 'PATCH')
  assert.equal(patchE.url.pathname, '/api/v1/phone_numbers/9')
  assert.equal(patchE.init.body, JSON.stringify({ not_current: true }))
  for (const c of calls) {
    assert.equal(c.init.headers['Content-Type'], 'application/json')
    assert.equal(c.init.headers.Authorization, 'Basic ' + Buffer.from('k:').toString('base64'))
  }
})
