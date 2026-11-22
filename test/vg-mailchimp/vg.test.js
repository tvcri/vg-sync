import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createVgReader } from '../../src/vg-mailchimp/vg.js'

const API = 'https://vg.example.org/api'
const OIDC = 'https://auth.example.org/realms/vg'
const TOKEN_URL = `${OIDC}/protocol/openid-connect/token`

function fakeFetch(responses, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url: new URL(url), init })
    const r = responses.shift()
    if (!r) return new Response('queue empty', { status: 500 })
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})
    return new Response(body, { status: r.status ?? 200 })
  }
}
const tok = (n = 1, expires_in = 300) => ({ body: { access_token: `t${n}`, expires_in } })

function make(responses, calls, extra = {}) {
  return createVgReader({
    apiUrl: API, oidcUrl: OIDC, clientId: 'vg-mc', clientSecret: 's3cret', scope: 'vg',
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
  assert.equal(form.get('client_id'), 'vg-mc')
  assert.equal(form.get('scope'), 'vg')
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
  const vg = make([{ status: 401, body: 'invalid_client' }])
  await assert.rejects(vg.whoAmI(), (e) => e.status === 401 && e.final === true)
  const vg2 = make([{ status: 400, body: '{"error":"invalid_client"}' }])
  await assert.rejects(vg2.whoAmI(), (e) => e.final === true)
  const vg3 = make([{ status: 500, body: 'boom' }])
  await assert.rejects(vg3.whoAmI(), (e) => e.final === false)
})

test('a 403 mentions the role grant, the privacy acknowledgement and the scope', async () => {
  const vg = make([tok(), { status: 403, body: 'forbidden' }])
  await assert.rejects(vg.listPersons(), (e) =>
    e.status === 403 && /VG GET \/persons → 403: forbidden/.test(e.message) &&
    /role grant/.test(e.message) && /privacy acknowledgement/.test(e.message) && /VG_SCOPE/.test(e.message))
})

test('listPersons asks for projection=detail and checks for the donor key', async () => {
  const calls = []
  const persons = [{ personId: 1, donor: null }]
  const vg = make([tok(), { body: persons }], calls)
  assert.deepEqual(await vg.listPersons(), persons)
  assert.equal(calls[1].url.pathname, '/api/persons')
  assert.equal(calls[1].url.searchParams.get('projection'), 'detail')
  await assert.rejects(make([tok(), { body: [{ personId: 1 }] }]).listPersons(), /donor:read is missing/)
  assert.deepEqual(await make([tok(), { body: [] }]).listPersons(), [])
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

test('reading sends only GET, apart from the token POST', async () => {
  const calls = []
  const vg = make([tok(), { body: {} }, { body: { privacyStatus: 'ok' } }, { body: [] }], calls)
  await vg.whoAmI(); await vg.privacyStatus(); await vg.listPersons()
  for (const c of calls) {
    assert.equal(c.init.method, c.url.href === TOKEN_URL ? 'POST' : 'GET')
  }
  assert.deepEqual(Object.keys(vg).sort(), ['acknowledgePrivacy', 'currentPrivacyRules', 'listPersons', 'privacyStatus', 'whoAmI'])
})
