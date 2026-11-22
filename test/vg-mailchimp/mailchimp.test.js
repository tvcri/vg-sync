import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { subscriberHash, createMailchimpClient } from '../../src/vg-mailchimp/mailchimp.js'

const json = (status, body, headers = {}) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers })

function setup(responses, opts = {}) {
  const calls = []
  const sleeps = []
  const queue = [...responses]
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init })
    const next = queue.length > 1 ? queue.shift() : queue[0]
    if (next instanceof Error) throw next
    return typeof next === 'function' ? next(url, init) : next
  }
  const client = createMailchimpClient({
    apiKey: 'abc-us20', listId: 'list1', fetchImpl, sleep: async (ms) => { sleeps.push(ms) }, ...opts,
  })
  return { client, calls, sleeps }
}

test('subscriberHash trims, lowercases, MD5 hex', () => {
  const md5 = createHash('md5').update('jane@example.org').digest('hex')
  assert.equal(subscriberHash(' Jane@Example.org '), md5)
  assert.equal(subscriberHash('jane@example.org'), md5)
})

test('datacenter and auth come from the key', async () => {
  const { client, calls } = setup([json(200, { id: 'list1', name: 'L', stats: {} })])
  await client.getList()
  assert.equal(calls[0].url.origin, 'https://us20.api.mailchimp.com')
  assert.equal(calls[0].url.pathname, '/3.0/lists/list1')
  assert.equal(calls[0].init.headers.Authorization, 'Basic ' + Buffer.from('anystring:abc-us20').toString('base64'))
})

test('listMembers pages by total_items', async () => {
  const m = (n) => ({ email_address: `p${n}@example.org`, status: 'subscribed', last_changed: 'x', merge_fields: {} })
  const { client, calls } = setup([
    json(200, { total_items: 3, members: [m(1), m(2)] }),
    json(200, { total_items: 3, members: [m(3)] }),
  ])
  const all = await client.listMembers()
  assert.equal(all.length, 3)
  assert.deepEqual(calls.map((c) => c.url.searchParams.get('offset')), ['0', '2'])
  assert.equal(calls[0].url.searchParams.get('count'), '1000')
  assert.equal(calls[0].url.searchParams.get('fields'),
    'members.email_address,members.status,members.last_changed,members.merge_fields,total_items')
})

test('a page without total_items throws', async () => {
  const { client } = setup([json(200, { members: [] })])
  await assert.rejects(client.listMembers(), /total_items/)
})

test('getMember returns null on 404', async () => {
  const { client } = setup([json(404, { title: 'Resource Not Found', detail: 'nope' })])
  assert.equal(await client.getMember('abc'), null)
})

test('putMember sends the exact body and no tags', async () => {
  const { client, calls } = setup([json(200, { id: 'x', status: 'subscribed' })])
  const out = await client.putMember('h1', { email: 'jane@example.org', firstName: 'Jane', lastName: null })
  assert.equal(out.status, 'subscribed')
  assert.equal(calls[0].init.method, 'PUT')
  assert.equal(calls[0].url.pathname, '/3.0/lists/list1/members/h1')
  assert.equal(calls[0].url.searchParams.get('skip_merge_validation'), 'true')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    email_address: 'jane@example.org', status_if_new: 'subscribed', merge_fields: { FNAME: 'Jane', LNAME: '' },
  })
  assert.ok(!('tags' in JSON.parse(calls[0].init.body)))
})

test('archiveMember DELETEs and accepts 204', async () => {
  const { client, calls } = setup([json(204, null)])
  assert.equal(await client.archiveMember('h1'), undefined)
  assert.equal(calls[0].init.method, 'DELETE')
  assert.equal(calls[0].url.pathname, '/3.0/lists/list1/members/h1')
})

test('listId is path-encoded', async () => {
  const { client, calls } = setup([json(200, {})], { listId: 'a/b' })
  await client.getList()
  assert.equal(calls[0].url.pathname, '/3.0/lists/a%2Fb')
})

test('429 honours Retry-After', async () => {
  const { client, sleeps } = setup([json(429, { detail: 'slow' }, { 'Retry-After': '2' }), json(200, { ok: 1 })])
  assert.deepEqual(await client.getList(), { ok: 1 })
  assert.deepEqual(sleeps, [2000])
})

test('five 503s throw after 4 tries with backoff, carrying status and detail', async () => {
  const { client, calls, sleeps } = setup([() => json(503, { title: 'Down', detail: 'maintenance' })])
  await assert.rejects(client.getList(), (e) => e.status === 503 && /maintenance/.test(e.message) && e.detail === 'maintenance')
  assert.equal(calls.length, 4)
  assert.deepEqual(sleeps, [1000, 2000, 4000])
})

test('network errors are retried', async () => {
  const { client, sleeps } = setup([new TypeError('fetch failed'), json(200, { ok: 1 })])
  assert.deepEqual(await client.getList(), { ok: 1 })
  assert.deepEqual(sleeps, [1000])
})

test('a timeout is retried and reported', async () => {
  const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' })
  const { client, calls } = setup([timeout])
  await assert.rejects(client.getList(), /timed out/)
  assert.equal(calls.length, 4)
})

test('401 is final and not retried', async () => {
  const { client, calls } = setup([json(401, { title: 'API Key Invalid', detail: 'bad key' })])
  await assert.rejects(client.getList(), (e) => e.status === 401 && e.final === true)
  assert.equal(calls.length, 1)
})

test('403 is final and not retried', async () => {
  const { client, calls } = setup([json(403, { title: 'Forbidden', detail: 'no access' })])
  await assert.rejects(client.getList(), (e) => e.status === 403 && e.final === true)
  assert.equal(calls.length, 1)
})

test('source never mentions delete-permanent', () => {
  assert.ok(!readFileSync('src/vg-mailchimp/mailchimp.js', 'utf8').includes('delete-permanent'))
})
