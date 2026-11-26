import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createJotformReader } from '../../src/jotform-vg/jotform.js'

const json = (status, body) => new Response(JSON.stringify(body), { status })
const sub = (i) => ({ id: String(1000000000000000000n + BigInt(i)), created_at: '2026-11-01 10:00:00', updated_at: null, status: 'ACTIVE', answers: {} })

function setup(responses, opts = {}) {
  const calls = []
  const queue = [...responses]
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init })
    const next = queue.length > 1 ? queue.shift() : queue[0]
    return typeof next === 'function' ? next(url, init) : next
  }
  return { calls, reader: createJotformReader({ apiKey: 'test-key', formId: '111', fetchImpl, ...opts }) }
}

test('listSince sends the filter and the APIKEY header', async () => {
  const { calls, reader } = setup([json(200, { responseCode: 200, content: [sub(1)] })])
  const out = await reader.listSince('updated_at', '2026-11-01 00:00:00')
  assert.equal(out.length, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url.origin + calls[0].url.pathname, 'https://api.jotform.com/form/111/submissions')
  assert.equal(calls[0].url.searchParams.get('filter'), '{"updated_at:gt":"2026-11-01 00:00:00"}')
  assert.equal(calls[0].url.searchParams.get('orderby'), 'id')
  assert.equal(calls[0].url.searchParams.get('limit'), '1000')
  assert.equal(calls[0].init.headers.APIKEY, 'test-key')
  assert.equal(calls[0].init.method, 'GET')
})

test('listSince rejects an unknown field', async () => {
  const { reader } = setup([json(200, { responseCode: 200, content: [] })])
  await assert.rejects(() => reader.listSince('status', 'x'))
})

test('listAll pages until a short page', async () => {
  const page1 = Array.from({ length: 1000 }, (_, i) => sub(i))
  const page2 = [sub(1000), sub(1001), sub(1002)]
  const { calls, reader } = setup([
    json(200, { responseCode: 200, content: page1 }),
    json(200, { responseCode: 200, content: page2 }),
  ])
  const out = await reader.listAll()
  assert.equal(out.length, 1003)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url.searchParams.get('offset'), '0')
  assert.equal(calls[1].url.searchParams.get('offset'), '1000')
  assert.equal(calls[0].url.searchParams.get('filter'), null)
  assert.equal(typeof out[0].id, 'string')
})

test('403 rejects as final; 500 is not final', async () => {
  const a = setup([json(403, { responseCode: 403, message: 'no' })])
  await assert.rejects(() => a.reader.listAll(), (e) => e.status === 403 && e.final === true)
  const b = setup([json(500, { responseCode: 500 })])
  await assert.rejects(() => b.reader.listAll(), (e) => e.status === 500 && !e.final)
})

test('a 200 response with a body responseCode other than 200 throws', async () => {
  const { reader } = setup([json(200, { responseCode: 401, message: 'bad key' })])
  await assert.rejects(() => reader.listAll(), /401/)
})

test('a timeout is reported plainly', async () => {
  const fetchImpl = async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }) }
  const reader = createJotformReader({ apiKey: 'k', formId: '1', fetchImpl })
  await assert.rejects(() => reader.listAll(), /timed out/)
})

test('ping returns the form status', async () => {
  const { calls, reader } = setup([json(200, { responseCode: 200, content: { id: '111', title: 'T', status: 'ENABLED' } })])
  assert.deepEqual(await reader.ping(), { status: 'ENABLED' })
  assert.equal(calls[0].url.pathname, '/form/111')
  assert.equal(calls[0].init.headers.APIKEY, 'test-key')
})
