import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createVgClient } from '../../src/jotform-vg/vg.js'

const API = 'https://vg.example.org/api'
const OIDC = 'https://auth.example.org/realms/vg'
const TOKEN_URL = `${OIDC}/protocol/openid-connect/token`
const ID = '5123456789012345678'

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
    apiUrl: API, oidcUrl: OIDC, clientId: 'vg-jf', clientSecret: 's3cret', scope: 'vg',
    fetchImpl: fakeFetch(responses, calls), ...extra,
  })
}

test('fetches a token with the client-credentials form and sends it as Bearer', async () => {
  const calls = []
  const vg = make([tok(1), { body: { userId: 7 } }], calls)
  assert.deepEqual(await vg.whoAmI(), { userId: 7 })
  assert.equal(calls[0].url.href, TOKEN_URL)
  const form = new URLSearchParams(calls[0].init.body)
  assert.equal(form.get('grant_type'), 'client_credentials')
  assert.equal(form.get('client_id'), 'vg-jf')
  assert.equal(calls[1].init.headers.Authorization, 'Bearer t1')
})

test('reuses the token until 30 seconds before it expires', async () => {
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
})

test('on 401 fetches a new token and retries once; a second 401 throws', async () => {
  const calls = []
  const vg = make([tok(1), { status: 401, body: 'expired' }, tok(2), { body: { ok: 1 } }], calls)
  assert.deepEqual(await vg.whoAmI(), { ok: 1 })
  assert.equal(calls[3].init.headers.Authorization, 'Bearer t2')
  const vg2 = make([tok(1), { status: 401, body: 'no' }, tok(2), { status: 401, body: 'still no' }])
  await assert.rejects(vg2.whoAmI(), (e) => e.status === 401 && /VG GET \/user → 401: still no/.test(e.message))
})

test('a refused sign-in is final', async () => {
  await assert.rejects(make([{ status: 401, body: 'invalid_client' }]).whoAmI(), (e) => e.status === 401 && e.final === true)
  await assert.rejects(make([{ status: 400, body: '{"error":"invalid_client"}' }]).whoAmI(), (e) => e.final === true)
  await assert.rejects(make([{ status: 500, body: 'boom' }]).whoAmI(), (e) => e.final === false)
  await assert.rejects(make([{ status: 400, body: '{"error":"invalid_scope"}' }]).whoAmI(), (e) => e.status === 400 && e.token === true && e.final === false)
})

test('a 403 mentions the role grant, the privacy acknowledgement and the scope', async () => {
  const vg = make([tok(), { status: 403, body: 'forbidden' }])
  await assert.rejects(vg.listPersons(), (e) =>
    e.status === 403 && /VG GET \/persons → 403: forbidden/.test(e.message) &&
    /role grant/.test(e.message) && /VG_SCOPE/.test(e.message))
})

test('a 403 privacy_ack_required names the setup command', async () => {
  const vg = make([tok(), { status: 403, body: '{"error":"privacy_ack_required"}' }])
  await assert.rejects(vg.listSubmissions(), (e) =>
    e.status === 403 && /privacy_ack_required/.test(e.message) && /setup command/.test(e.message))
})

test('a 422 carries VG error detail, cut to 200 characters', async () => {
  const vg = make([tok(), { status: 422, body: JSON.stringify({ error: 'bad row', detail: 'x'.repeat(500) }) }])
  await assert.rejects(vg.putSubmission(ID, {}), (e) =>
    e.status === 422 && /bad row/.test(e.message) && e.message.length < 320)
})

test('reads send GET with the right path and query', async () => {
  const calls = []
  const vg = make([tok(), { body: [] }, { body: [] }, { body: { cursor: null, count: 0 } }, { body: [] }, { body: [] }, { body: [] }], calls)
  await vg.listPersons(); await vg.listVillages(); await vg.getState()
  await vg.listSubmissions(); await vg.listNameMatches(); await vg.listOpenHolds()
  const got = calls.slice(1).map((c) => [c.init.method, c.url.pathname + c.url.search])
  assert.deepEqual(got, [
    ['GET', '/api/persons?projection=detail'],
    ['GET', '/api/villages'],
    ['GET', '/api/friends/sync/state'],
    ['GET', '/api/friends/sync/submissions'],
    ['GET', '/api/friends/sync/name-matches'],
    ['GET', '/api/friends/sync/holds?state=open'],
  ])
})

test('putSubmission sends JSON with the id kept as a string in the URL', async () => {
  const calls = []
  const vg = make([tok(), { body: { ok: 1 } }, { body: {} }], calls)
  const row = { note: 'hello', n: 2 }
  assert.deepEqual(await vg.putSubmission(ID, row), { ok: 1 })
  assert.equal(calls[1].init.method, 'PUT')
  assert.equal(calls[1].url.pathname, `/api/friends/sync/submissions/${ID}`)
  assert.equal(calls[1].init.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[1].init.body), row)
  await vg.putSubmission('a/b ?', {})
  assert.equal(calls[2].url.pathname, '/api/friends/sync/submissions/a%2Fb%20%3F')
})

test('deleteSubmission handles an empty 204', async () => {
  const calls = []
  const vg = make([tok(), { status: 204 }], calls)
  await vg.deleteSubmission(ID)
  assert.equal(calls[1].init.method, 'DELETE')
  assert.equal(calls[1].url.pathname, `/api/friends/sync/submissions/${ID}`)
  assert.equal(calls[1].init.body, undefined)
})

test('putHolds sends the holds and returns the counts', async () => {
  const calls = []
  const vg = make([tok(), { body: { opened: 1, updated: 2, closed: 3 } }], calls)
  const holds = [{ submissionId: ID, kind: 'unreadable' }]
  assert.deepEqual(await vg.putHolds(holds), { opened: 1, updated: 2, closed: 3 })
  assert.equal(calls[1].init.method, 'PUT')
  assert.equal(calls[1].url.pathname, '/api/friends/sync/holds')
  assert.deepEqual(JSON.parse(calls[1].init.body), holds)
})

test('privacyStatus and currentPrivacyRules read; acknowledgePrivacy posts', async () => {
  const calls = []
  const vg = make([tok(), { body: { privacyStatus: 'ok' } }, { body: { id: 3 } }, { body: {} }], calls)
  assert.equal(await vg.privacyStatus(), 'ok')
  assert.deepEqual(await vg.currentPrivacyRules(), { id: 3 })
  await vg.acknowledgePrivacy(3)
  assert.equal(calls[3].url.pathname, '/api/privacy/acknowledgements')
  assert.equal(calls[3].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[3].init.body), { rulesId: 3 })
})
