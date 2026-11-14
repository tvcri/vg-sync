import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideGuards, runGuards } from '../../harness/guards.js'

const env = {
  LGL_API_KEY: 'k', LGL_MEMBERSHIP_FUND_ID: '1', LGL_PAYPAL_PAYMENT_TYPE_ID: '2',
  VG_API_URL: 'http://localhost:64001/api', VG_OIDC_URL: 'http://127.0.0.1:8090',
  VG_CLIENT_ID: 'a', VG_CLIENT_SECRET: 'b', HARNESS_VG_CLIENT_ID: 'c', HARNESS_VG_CLIENT_SECRET: 'd',
  HARNESS_DB_CONTAINER: 'village-green-orch-db-1', HARNESS_DB_PASSWORD: 'p', HARNESS_DB_SCHEMA: 'vg',
}
const good = { env, lglCount: 12, sentinelFound: true, foreignDonors: 0 }

test('a complete local setup passes', () => {
  assert.deepEqual(decideGuards(good), { ok: true, failed: [] })
})

for (const name of Object.keys(env)) {
  test(`empty ${name} fails alone`, () => {
    const r = decideGuards({ ...good, env: { ...env, [name]: '' } })
    assert.equal(r.ok, false)
    assert.equal(r.failed.length, 1)
    assert.match(r.failed[0], new RegExp(name))
  })
}

const alone = (label, input, re) => test(`${label} fails alone`, () => {
  const r = decideGuards(input)
  assert.equal(r.ok, false)
  assert.equal(r.failed.length, 1)
  assert.match(r.failed[0], re)
})
alone('200 constituents', { ...good, lglCount: 200 }, /200/)
alone('no sentinel', { ...good, sentinelFound: false }, /sentinel/i)
alone('remote API host', { ...good, env: { ...env, VG_API_URL: 'https://vg.example.org/api' } }, /VG_API_URL/)
alone('remote OIDC host', { ...good, env: { ...env, VG_OIDC_URL: 'https://auth.example.org' } }, /VG_OIDC_URL/)
alone('unparseable URL', { ...good, env: { ...env, VG_API_URL: 'not a url' } }, /VG_API_URL/)
alone('demo container', { ...good, env: { ...env, HARNESS_DB_CONTAINER: 'village-green-demo-db-1' } }, /demo/)
alone('demo container, bare name', { ...good, env: { ...env, HARNESS_DB_CONTAINER: 'village-green-demo' } }, /demo/)
alone('demo API port', { ...good, env: { ...env, VG_API_URL: 'http://localhost:54000/api' } }, /VG_API_URL/)
alone('demo API port 64003', { ...good, env: { ...env, VG_API_URL: 'http://localhost:64003/api' } }, /VG_API_URL/)
alone('demo auth port', { ...good, env: { ...env, VG_OIDC_URL: 'http://localhost:8091' } }, /VG_OIDC_URL/)
alone('no port on the API URL', { ...good, env: { ...env, VG_API_URL: 'http://localhost/api' } }, /VG_API_URL/)
alone('remote DB host', { ...good, env: { ...env, HARNESS_DB_HOST: 'db.example.org' } }, /HARNESS_DB_HOST/)
alone('demo DB port', { ...good, env: { ...env, HARNESS_DB_PORT: '60002' } }, /60002/)
alone('demo container, mixed case and padded', { ...good, env: { ...env, HARNESS_DB_CONTAINER: '  Village-Green-DEMO-db-1 ' } }, /demo/)
alone('whitespace-only required variable', { ...good, env: { ...env, LGL_API_KEY: '   ' } }, /LGL_API_KEY/)
test('local DB hosts and an unset DB host pass', () => {
  for (const h of [undefined, '', '  ', 'localhost', '127.0.0.1', '::1', '[::1]']) {
    assert.deepEqual(decideGuards({ ...good, env: { ...env, HARNESS_DB_HOST: h } }), { ok: true, failed: [] }, String(h))
  }
})
test('an IPv6 loopback URL on the dev port passes', () => {
  assert.equal(decideGuards({ ...good, env: { ...env, VG_API_URL: 'http://[::1]:64001/api' } }).ok, true)
})
alone('foreign donors', { ...good, foreignDonors: 1 }, /donor/i)
alone('unknown count', { ...good, lglCount: null }, /count/i)

test('two failures report both', () => {
  const r = decideGuards({ ...good, lglCount: 5000, sentinelFound: false })
  assert.equal(r.failed.length, 2)
})

// runGuards, with a fake writer and reader
const writer = (over = {}) => ({
  countConstituents: async () => 12,
  request: async () => ({ items: [{ first_name: 'Zztrial', last_name: 'Sentinel' }], total_items: 1 }),
  ...over,
})
const reader = (cs, gs) => ({ pullConstituents: async () => cs, pullGifts: async () => gs })

test('runGuards passes on a trial-shaped account', async () => {
  const r = await runGuards({
    env, lglWriter: writer(),
    lglReader: reader([{ id: 1, external_constituent_id: 'vg-sync-harness' }, { id: 2 }], [{ constituent_id: 1 }]),
  })
  assert.deepEqual(r, { ok: true, failed: [] })
})

test('runGuards counts a non-harness constituent with a gift', async () => {
  const r = await runGuards({
    env, lglWriter: writer(),
    lglReader: reader([{ id: 1, external_constituent_id: 'vg-sync-harness' }, { id: 2 }], [{ constituent_id: 2 }]),
  })
  assert.equal(r.ok, false)
  assert.match(r.failed[0], /donor/i)
})

test('runGuards fails closed when the count cannot be read', async () => {
  const r = await runGuards({
    env, lglReader: reader([], []),
    lglWriter: writer({ countConstituents: async () => { throw new Error('LGL 401') } }),
  })
  assert.equal(r.ok, false)
  assert.ok(r.failed.some((f) => /count/i.test(f) && /401/.test(f)))
})

test('runGuards fails closed when the sentinel search errors', async () => {
  const r = await runGuards({
    env, lglReader: reader([], []),
    lglWriter: writer({ request: async () => { throw new Error('LGL 500') } }),
  })
  assert.equal(r.ok, false)
  assert.ok(r.failed.some((f) => /sentinel/i.test(f) && /500/.test(f)))
})

test('runGuards fails closed when the pull errors', async () => {
  const r = await runGuards({
    env, lglWriter: writer(),
    lglReader: { pullConstituents: async () => { throw new Error('boom') }, pullGifts: async () => [] },
  })
  assert.equal(r.ok, false)
  assert.ok(r.failed.some((f) => /donor/i.test(f) && /boom/.test(f)))
})
