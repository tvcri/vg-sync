import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createVgClient } from '../../src/lgl-vg/vg.js'

const API = 'https://vg.example.org/api'
const OIDC = 'https://auth.example.org/realms/vg'
const TOKEN_URL = `${OIDC}/protocol/openid-connect/token`

// Serves queued responses and records each call. A response's body is JSON-encoded unless it is a string.
function fakeFetch(responses, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url: new URL(url), init })
    const r = responses.shift()
    if (!r) return new Response('queue empty', { status: 500 })
    if (r.status === 204) return new Response(null, { status: 204 })
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})
    return new Response(body, { status: r.status ?? 200 })
  }
}
const tok = (n = 1, expires_in = 300) => ({ body: { access_token: `t${n}`, expires_in } })

function make(responses, calls, extra = {}) {
  return createVgClient({
    apiUrl: API,
    oidcUrl: OIDC,
    clientId: 'vg-sync',
    clientSecret: 's3cret',
    scope: 'vg',
    fetchImpl: fakeFetch(responses, calls),
    ...extra,
  })
}

test('fetches a token with the client-credentials form and sends it as Bearer', async () => {
  const calls = []
  const vg = make([tok(1), { body: { userId: 7 } }], calls)
  assert.deepEqual(await vg.whoAmI(), { userId: 7 })
  assert.equal(calls[0].url.href, TOKEN_URL)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded')
  const form = new URLSearchParams(calls[0].init.body)
  assert.equal(form.get('grant_type'), 'client_credentials')
  assert.equal(form.get('client_id'), 'vg-sync')
  assert.equal(form.get('client_secret'), 's3cret')
  assert.equal(form.get('scope'), 'vg')
  assert.equal(calls[1].url.href, `${API}/user`)
  assert.equal(calls[1].init.method, 'GET')
  assert.equal(calls[1].init.headers.Authorization, 'Bearer t1')
})

test('reuses the token until 30 seconds before it expires, then fetches another', async () => {
  const calls = []
  let t = 0
  const vg = make([tok(1), {}, {}, tok(2), {}], calls, { now: () => t })
  await vg.whoAmI()
  t = 269000
  await vg.whoAmI()
  assert.equal(calls.filter((c) => c.url.href === TOKEN_URL).length, 1)
  t = 271000
  await vg.whoAmI()
  assert.equal(calls.filter((c) => c.url.href === TOKEN_URL).length, 2)
  assert.equal(calls[4].init.headers.Authorization, 'Bearer t2')
})

test('on 401 fetches a new token and retries once; a second 401 throws', async () => {
  const calls = []
  const vg = make([tok(1), { status: 401, body: 'expired' }, tok(2), { body: { ok: 1 } }], calls)
  assert.deepEqual(await vg.whoAmI(), { ok: 1 })
  assert.equal(calls[3].init.headers.Authorization, 'Bearer t2')

  const vg2 = make([tok(1), { status: 401, body: 'no' }, tok(2), { status: 401, body: 'still no' }])
  await assert.rejects(vg2.whoAmI(), (err) => err.status === 401 && /VG GET \/user → 401: still no/.test(err.message))
})

test('listPersons asks for projection=detail and returns the array', async () => {
  const calls = []
  const persons = [{ personId: 1, donor: null, detail: {} }]
  const vg = make([tok(), { body: persons }], calls)
  assert.deepEqual(await vg.listPersons(), persons)
  assert.equal(calls[1].url.pathname, '/api/persons')
  assert.equal(calls[1].url.searchParams.get('projection'), 'detail')
})

test('listPersons throws when no person carries a donor property', async () => {
  const vg = make([tok(), { body: [{ personId: 1, detail: {} }] }])
  await assert.rejects(vg.listPersons(), /donor:read/)
})

test('listPersons accepts donor: null', async () => {
  const vg = make([tok(), { body: [{ personId: 1, donor: null, detail: {} }] }])
  assert.equal((await vg.listPersons()).length, 1)
})

test('listPersons accepts an empty array', async () => {
  const vg = make([tok(), { body: [] }])
  assert.deepEqual(await vg.listPersons(), [])
})

test('a 403 from the API mentions the role grant, the privacy acknowledgement and the scope', async () => {
  const vg = make([tok(), { status: 403, body: 'forbidden' }])
  await assert.rejects(vg.listPersons(), (err) =>
    err.status === 403 &&
    /VG GET \/persons → 403: forbidden/.test(err.message) &&
    /role grant/.test(err.message) &&
    /privacy acknowledgement/.test(err.message) &&
    /VG_SCOPE/.test(err.message))
})

test('a token endpoint failure names Keycloak, not the API', async () => {
  const calls = []
  const vg = make([{ status: 401, body: 'invalid_client' }], calls)
  await assert.rejects(vg.whoAmI(), (err) => err.status === 401 && /Keycloak token/.test(err.message))
  assert.equal(calls.length, 1)
})

test('truncates the error body to 200 characters', async () => {
  const vg = make([tok(), { status: 500, body: 'x'.repeat(500) }])
  await assert.rejects(vg.whoAmI(), (err) => err.status === 500 && err.message.endsWith(': ' + 'x'.repeat(200)))
})

test('privacyStatus asks for projection=privacyStatus and returns that object', async () => {
  const calls = []
  const status = { needsAck: true, pendingRulesId: 3 }
  const vg = make([tok(), { body: { userId: 7, privacyStatus: status } }], calls)
  assert.deepEqual(await vg.privacyStatus(), status)
  assert.equal(calls[1].url.pathname, '/api/user')
  assert.equal(calls[1].url.searchParams.get('projection'), 'privacyStatus')
})

test('currentPrivacyRules gets /privacy/rules', async () => {
  const calls = []
  const vg = make([tok(), { body: { id: 3, content: 'Rules' } }], calls)
  assert.deepEqual(await vg.currentPrivacyRules(), { id: 3, content: 'Rules' })
  assert.equal(calls[1].url.pathname, '/api/privacy/rules')
  assert.equal(calls[1].init.method, 'GET')
})

test('acknowledgePrivacy posts { rulesId } to /privacy/acknowledgements', async () => {
  const calls = []
  const vg = make([tok(), { status: 201, body: { rulesId: 3 } }], calls)
  await vg.acknowledgePrivacy(3)
  assert.equal(calls[1].url.pathname, '/api/privacy/acknowledgements')
  assert.equal(calls[1].init.method, 'POST')
  assert.equal(calls[1].init.headers.Authorization, 'Bearer t1')
  assert.equal(calls[1].init.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[1].init.body), { rulesId: 3 })
})

test('a failed acknowledgement names POST and carries the status', async () => {
  const vg = make([tok(), { status: 409, body: 'stale' }])
  await assert.rejects(vg.acknowledgePrivacy(3), (err) => err.status === 409 && /VG POST \/privacy\/acknowledgements → 409/.test(err.message))
})

const json = (call) => JSON.parse(call.init.body)

test('getLinkedPersons lists persons by LGL constituent id with projection=detail', async () => {
  const calls = []
  const vg = make([tok(), { body: [{ personId: '7' }] }], calls)
  assert.deepEqual(await vg.getLinkedPersons(101), [{ personId: '7' }])
  assert.equal(calls[1].init.method, 'GET')
  assert.equal(calls[1].url.pathname, '/api/persons')
  assert.equal(calls[1].url.searchParams.get('lglConstituentId'), '101')
  assert.deepEqual(calls[1].url.searchParams.getAll('projection'), ['detail'])
})

test('patchPerson PATCHes the body; a 422 carries its status', async () => {
  const calls = []
  const vg = make([tok(), { body: { personId: 7 } }], calls)
  await vg.patchPerson(7, { detail: { firstName: 'Jane' } })
  assert.equal(calls[1].init.method, 'PATCH')
  assert.equal(calls[1].url.pathname, '/api/persons/7')
  assert.deepEqual(json(calls[1]), { detail: { firstName: 'Jane' } })

  const bad = make([tok(), { status: 422, body: 'invalid' }])
  await assert.rejects(bad.patchPerson(7, {}), (err) => err.status === 422)
})

test('putDonor PUTs to /persons/{id}/donor', async () => {
  const calls = []
  const vg = make([tok(), { body: { personId: 7 } }], calls)
  await vg.putDonor(7, { lglConstituentId: 101, lastGiftDate: '2026-01-02' })
  assert.equal(calls[1].init.method, 'PUT')
  assert.equal(calls[1].url.pathname, '/api/persons/7/donor')
  assert.deepEqual(json(calls[1]), { lglConstituentId: 101, lastGiftDate: '2026-01-02' })
})

test('geocodeTown POSTs the address and returns the town object', async () => {
  const calls = []
  const vg = make([tok(), { body: { town: null } }], calls)
  const addr = { street: '1 Main St', city: 'Springfield', state: 'XX', zip: '00000' }
  assert.deepEqual(await vg.geocodeTown(addr), { town: null })
  assert.equal(calls[1].init.method, 'POST')
  assert.equal(calls[1].url.pathname, '/api/op/geocode/town')
  assert.deepEqual(json(calls[1]), addr)
})

test('getSyncFields gets /sync/fields', async () => {
  const calls = []
  const rows = [{ personId: 7, field: 'email' }]
  const vg = make([tok(), { body: rows }], calls)
  assert.deepEqual(await vg.getSyncFields(), rows)
  assert.equal(calls[1].init.method, 'GET')
  assert.equal(calls[1].url.pathname, '/api/sync/fields')
})

test('putSyncFields sends batches of 500 and sums upserted', async () => {
  const calls = []
  const rows = Array.from({ length: 1201 }, (_, i) => ({ personId: i }))
  const vg = make([tok(), { body: { upserted: 500 } }, { body: { upserted: 500 } }, { body: { upserted: 200 } }], calls)
  assert.equal(await vg.putSyncFields(rows), 1200)
  const puts = calls.slice(1)
  assert.deepEqual(puts.map((c) => c.init.method), ['PUT', 'PUT', 'PUT'])
  assert.ok(puts.every((c) => c.url.pathname === '/api/sync/fields'))
  assert.deepEqual(puts.map((c) => json(c).length), [500, 500, 201])
})

test('putSyncFields with no rows makes no call', async () => {
  const calls = []
  const vg = make([], calls)
  assert.equal(await vg.putSyncFields([]), 0)
  assert.equal(calls.length, 0)
})

test('getSyncHolds repeats the state param', async () => {
  const calls = []
  const vg = make([tok(), { body: [] }], calls)
  await vg.getSyncHolds(['open', 'dismissed'])
  assert.equal(calls[1].url.pathname, '/api/sync/holds')
  assert.deepEqual(calls[1].url.searchParams.getAll('state'), ['open', 'dismissed'])
})

test('createSyncHolds splits at 500 and returns rows in input order', async () => {
  const calls = []
  const items = Array.from({ length: 501 }, (_, i) => ({ n: i }))
  const echo = (xs) => xs.map((x) => ({ holdId: x.n }))
  const vg = make([tok(), { body: echo(items.slice(0, 500)) }, { body: echo(items.slice(500)) }], calls)
  const out = await vg.createSyncHolds(items)
  assert.deepEqual(out.map((h) => h.holdId), items.map((x) => x.n))
  assert.equal(calls.length, 3)
  assert.equal(calls[1].init.method, 'POST')
  assert.equal(calls[1].url.pathname, '/api/sync/holds')
})

test('patchSyncHolds PATCHes and sums updated', async () => {
  const calls = []
  const items = Array.from({ length: 501 }, (_, i) => ({ holdId: i }))
  const vg = make([tok(), { body: { updated: 500 } }, { body: { updated: 1 } }], calls)
  assert.equal(await vg.patchSyncHolds(items), 501)
  assert.equal(calls[1].init.method, 'PATCH')
  assert.equal(calls[1].url.pathname, '/api/sync/holds')
  assert.deepEqual([json(calls[1]).length, json(calls[2]).length], [500, 1])
})

test('startRun POSTs to /sync/runs', async () => {
  const calls = []
  const body = { kind: 'full', switches: { a: true }, imageRevision: 'abc', policyHash: 'def' }
  const vg = make([tok(), { body: { runId: 3 } }], calls)
  assert.deepEqual(await vg.startRun(body), { runId: 3 })
  assert.equal(calls[1].init.method, 'POST')
  assert.equal(calls[1].url.pathname, '/api/sync/runs')
  assert.deepEqual(json(calls[1]), body)
})

test('finishRun PATCHes /sync/runs/{id}', async () => {
  const calls = []
  const body = { result: 'ok', counts: { a: 1 }, lglCursor: 'x', vgCursor: 'y', error: null }
  const vg = make([tok(), { body: { runId: 3 } }], calls)
  await vg.finishRun(3, body)
  assert.equal(calls[1].init.method, 'PATCH')
  assert.equal(calls[1].url.pathname, '/api/sync/runs/3')
  assert.deepEqual(json(calls[1]), body)
})

test('finishRun without counts sends no counts key (SyncRunPatch.counts is not nullable)', async () => {
  const calls = []
  const vg = make([tok(), { body: { runId: 3 } }], calls)
  await vg.finishRun(3, { result: 'failed', lglCursor: null, vgCursor: null, error: 'boom' })
  assert.deepEqual(json(calls[1]), { result: 'failed', lglCursor: null, vgCursor: null, error: 'boom' })
})

test('lastFullRun returns the newest ok run, skipping failed and running ones', async () => {
  const calls = []
  const runs = [{ runId: 5, result: 'running' }, { runId: 4, result: 'failed' }, { runId: 3, result: 'ok' }, { runId: 2, result: 'ok' }]
  const vg = make([tok(), { body: runs }, { body: [] }], calls)
  assert.equal((await vg.lastFullRun()).runId, 3)
  assert.equal(calls[1].url.pathname, '/api/sync/runs')
  assert.deepEqual(calls[1].url.searchParams.getAll('kind'), ['full'])
  assert.equal(calls[1].url.searchParams.get('limit'), '20')
  assert.equal(await vg.lastFullRun(), null)
})

test('createPerson posts the body; deleteDonor sends DELETE and takes a 204 with no body', async () => {
  const calls = []
  const vg = make([tok(), { status: 201, body: { personId: '42' } }, { status: 204 }], calls)
  assert.deepEqual(await vg.createPerson({ lastName: 'Doe', firstName: 'Jane' }), { personId: '42' })
  assert.equal(calls[1].init.method, 'POST')
  assert.equal(calls[1].url.pathname, '/api/persons')
  assert.deepEqual(JSON.parse(calls[1].init.body), { lastName: 'Doe', firstName: 'Jane' })
  assert.equal(await vg.deleteDonor('42'), null)
  assert.equal(calls[2].init.method, 'DELETE')
  assert.equal(calls[2].url.pathname, '/api/persons/42/donor')
})
