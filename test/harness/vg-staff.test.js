import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createVgStaff } from '../../harness/vg-staff.js'

const API = 'http://localhost:64001/api'
const OIDC = 'http://localhost:8090/realms/vg'
const TOKEN_URL = `${OIDC}/protocol/openid-connect/token`

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
  return createVgStaff({
    apiUrl: API, oidcUrl: OIDC, clientId: 'vg-sync-harness', clientSecret: 's3cret',
    fetchImpl: fakeFetch(responses, calls), ...extra,
  })
}

test('fetches the token once with client credentials and reuses it', async () => {
  const calls = []
  const staff = make([tok(1), { body: { personId: '1' } }, { body: [] }], calls)
  await staff.createPerson({ firstName: 'Jane', lastName: 'Doe' })
  await staff.listHolds(['open'])
  assert.equal(calls.filter((c) => c.url.href === TOKEN_URL).length, 1)
  const form = new URLSearchParams(calls[0].init.body)
  assert.equal(form.get('grant_type'), 'client_credentials')
  assert.equal(form.get('client_id'), 'vg-sync-harness')
  assert.equal(calls[1].init.headers.Authorization, 'Bearer t1')
  assert.equal(calls[2].init.headers.Authorization, 'Bearer t1')
})

test('refreshes the token 30 seconds before it expires', async () => {
  const calls = []
  let t = 0
  const staff = make([tok(1, 60), { body: [] }, tok(2), { body: [] }], calls, { now: () => t })
  await staff.listHolds(['open'])
  t = 31_000
  await staff.listHolds(['open'])
  assert.equal(calls[3].init.headers.Authorization, 'Bearer t2')
})

test('dismissHold posts the staff dismissal to the hold', async () => {
  const calls = []
  const staff = make([tok(), { body: { holdId: '7', state: 'dismissed' } }], calls)
  const hold = await staff.dismissHold(7, { dismissalKind: 'staff' })
  assert.equal(hold.state, 'dismissed')
  assert.equal(calls[1].url.href, `${API}/sync/holds/7/dismissal`)
  assert.equal(calls[1].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[1].init.body), { dismissalKind: 'staff' })
})

test('person and donor calls use the API paths', async () => {
  const calls = []
  const staff = make([
    tok(),
    { status: 201, body: { personId: '9' } },
    { body: { personId: '9' } },
    { body: { personId: '9' } },
    { status: 204 },
    { body: [{ personId: '9' }] },
    { body: [{ personId: '8' }, { personId: '9', detail: {} }] },
    { body: [] },
  ], calls)
  assert.deepEqual(await staff.createPerson({ firstName: 'Jane' }), { personId: '9' })
  await staff.patchPerson('9', { lastName: 'Doe' })
  await staff.putDonor('9', { lglConstituentId: 123, lastGiftDate: '2026-01-02' }) // LGL ids are numbers; the API takes a string
  assert.equal(await staff.deleteDonor('9'), null)
  await staff.getPersons('123')
  assert.deepEqual(await staff.getPerson(9), { personId: '9', detail: {} })
  await staff.listHolds(['open', 'dismissed'])
  const seen = calls.slice(1).map((c) => `${c.init.method} ${c.url.pathname}${c.url.search}`)
  assert.deepEqual(seen, [
    'POST /api/persons',
    'PATCH /api/persons/9',
    'PUT /api/persons/9/donor',
    'DELETE /api/persons/9/donor',
    'GET /api/persons?lglConstituentId=123&projection=detail',
    'GET /api/persons?projection=detail',
    'GET /api/sync/holds?state=open&state=dismissed',
  ])
  assert.deepEqual(JSON.parse(calls[3].init.body), { lglConstituentId: '123', lastGiftDate: '2026-01-02' })
})

test('getPerson returns null for an unknown id', async () => {
  const staff = make([tok(), { body: [{ personId: '8' }] }])
  assert.equal(await staff.getPerson('9'), null)
})

test('acknowledgePrivacy acknowledges the current rules when owed', async () => {
  const calls = []
  const staff = make([
    tok(),
    { body: { privacyStatus: { needsAck: true } } },
    { body: { id: 3 } },
    { status: 201, body: { id: 1 } },
  ], calls)
  assert.deepEqual(await staff.acknowledgePrivacy(), { acknowledged: true })
  assert.equal(calls[3].url.pathname, '/api/privacy/acknowledgements')
  assert.deepEqual(JSON.parse(calls[3].init.body), { rulesId: 3 })
})

test('acknowledgePrivacy does nothing when nothing is owed', async () => {
  const calls = []
  const staff = make([tok(), { body: { privacyStatus: { needsAck: false } } }], calls)
  assert.deepEqual(await staff.acknowledgePrivacy(), { acknowledged: false })
  assert.equal(calls.length, 2)
})

test('an API error names the method, path and status', async () => {
  const staff = make([tok(), { status: 422, body: 'bad' }])
  await assert.rejects(staff.patchPerson('9', {}), /PATCH \/persons\/9 → 422/)
})

test('appendSyncLog posts the rows; getSyncLog reads one person\'s rows by outcome', async () => {
  const calls = []
  const staff = make([tok(), { status: 201, body: { appended: 1 } }, { body: [{ logId: '1' }] }], calls)
  assert.deepEqual(await staff.appendSyncLog([{ lglConstituentId: '5', outcome: 'written' }]), { appended: 1 })
  assert.deepEqual(await staff.getSyncLog({ personId: 9, outcome: 'written' }), [{ logId: '1' }])
  const seen = calls.slice(1).map((c) => `${c.init.method} ${c.url.pathname}${c.url.search}`)
  assert.deepEqual(seen, ['POST /api/sync/log', 'GET /api/sync/log?personId=9&outcome=written&limit=100'])
  assert.deepEqual(JSON.parse(calls[1].init.body), [{ lglConstituentId: '5', outcome: 'written' }])
})
