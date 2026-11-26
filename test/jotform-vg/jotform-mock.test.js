import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMockJotformFetch, openJotform } from '../../src/jotform-vg/jotform-mock.js'
import { createJotformReader } from '../../src/jotform-vg/jotform.js'

const mk = (id, created, updated = null) => ({ id, created_at: created, updated_at: updated, status: 'ACTIVE', answers: { 3: { answer: 'Jane Doe' } } })
const subs = () => [
  mk('3000000000000000001', '2026-11-01 09:00:00'),
  mk('3000000000000000002', '2026-11-02 09:00:00', '2026-11-05 12:00:00'),
  mk('3000000000000000003', '2026-11-03 09:00:00'),
]
const reader = (state) => createJotformReader({ apiKey: 'k', formId: '222', fetchImpl: createMockJotformFetch({ state, persist: async () => {} }) })

test('listSince created_at returns only later submissions; listAll returns all', async () => {
  const r = reader({ submissions: subs() })
  const out = await r.listSince('created_at', '2026-11-02 09:00:00')
  assert.deepEqual(out.map((s) => s.id), ['3000000000000000003'])
  assert.equal((await r.listAll()).length, 3)
})

test('listSince updated_at skips never-edited submissions', async () => {
  const r = reader({ submissions: subs() })
  const out = await r.listSince('updated_at', '2026-11-01 00:00:00')
  assert.deepEqual(out.map((s) => s.id), ['3000000000000000002'])
})

test('the mock honors limit and offset', async () => {
  const state = { submissions: subs() }
  const f = createMockJotformFetch({ state, persist: async () => {} })
  const res = await f('https://mock.api.jotform.com/form/222/submissions?limit=2&offset=1&orderby=id')
  const body = await res.json()
  assert.equal(body.responseCode, 200)
  assert.deepEqual(body.content.map((s) => s.id), ['3000000000000000002', '3000000000000000003'])
})

test('anything else is 404, and ping serves state.form', async () => {
  const state = { submissions: [] }
  const f = createMockJotformFetch({ state, persist: async () => {} })
  assert.equal((await f('https://mock.api.jotform.com/user')).status, 404)
  assert.equal((await f('https://mock.api.jotform.com/form/222/submissions', { method: 'POST' })).status, 404)
  assert.deepEqual(await reader(state).ping(), { status: 'ENABLED' })
  assert.deepEqual(await reader({ submissions: [], form: { status: 'DELETED' } }).ping(), { status: 'DELETED' })
})

test('openJotform: mock state file when config.jotform.mock is set', async () => {
  const readFile = async () => JSON.stringify({ submissions: subs() })
  const r = await openJotform({ jotform: { mock: '/x/state.json', formId: '222' } }, { readFile, writeFile: async () => {} })
  assert.equal((await r.listAll()).length, 3)
  await assert.rejects(() => openJotform({ jotform: { mock: '/x/s.json', formId: '2' } }, { readFile: async () => '{}', writeFile: async () => {} }), /submissions/)
  await assert.rejects(() => openJotform({ jotform: { mock: '/x/s.json', formId: '2' } }, { readFile: async () => { throw Object.assign(new Error('n'), { code: 'ENOENT' }) }, writeFile: async () => {} }), /ENOENT/)
})

test('openJotform: real reader otherwise, via fetchImpl', async () => {
  let seen
  const fetchImpl = async (url, init) => { seen = { url: String(url), init }; return new Response(JSON.stringify({ responseCode: 200, content: [] }), { status: 200 }) }
  const r = await openJotform({ jotform: { apiKey: 'real', formId: '9', mock: null } }, { fetchImpl })
  await r.listAll()
  assert.match(seen.url, /^https:\/\/api\.jotform\.com\/form\/9\/submissions/)
  assert.equal(seen.init.headers.APIKEY, 'real')
})
