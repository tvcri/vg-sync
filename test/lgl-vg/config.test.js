import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../../src/lgl-vg/config.js'

const full = {
  LGL_API_KEY: 'k', LGL_MEMBERSHIP_FUND_ID: '11', LGL_PAYPAL_PAYMENT_TYPE_ID: '22',
  VG_API_URL: 'https://vg.example.org/api/', VG_OIDC_URL: 'https://auth.example.org/realms/vg/',
  VG_CLIENT_ID: 'vg-sync', VG_CLIENT_SECRET: 's',
}

test('loadConfig reads values, converts ids to numbers, strips trailing slashes, applies defaults', () => {
  const c = loadConfig(full)
  assert.deepEqual(c.lgl, { apiKey: 'k', membershipFundId: 11, paypalPaymentTypeId: 22 })
  assert.equal(c.vg.apiUrl, 'https://vg.example.org/api')
  assert.equal(c.vg.oidcUrl, 'https://auth.example.org/realms/vg')
  assert.equal(c.vg.scope, 'vg')
  assert.equal(c.createHorizonYears, 5)
})

test('loadConfig names every missing variable in one error', () => {
  const { LGL_API_KEY, VG_CLIENT_SECRET, ...rest } = full
  assert.throws(() => loadConfig(rest), /LGL_API_KEY.*VG_CLIENT_SECRET/s)
})

test('loadConfig rejects a non-numeric fund id and a non-https URL', () => {
  assert.throws(() => loadConfig({ ...full, LGL_MEMBERSHIP_FUND_ID: 'x' }), /LGL_MEMBERSHIP_FUND_ID/)
  assert.throws(() => loadConfig({ ...full, VG_API_URL: 'http://vg.example.org/api' }), /VG_API_URL/)
})

test('loadConfig allows http for localhost', () => {
  assert.equal(loadConfig({ ...full, VG_API_URL: 'http://localhost:64001/api' }).vg.apiUrl, 'http://localhost:64001/api')
})

test('loadConfig applies defaults for the step 3 settings', () => {
  const c = loadConfig(full)
  assert.equal(c.circuitBreakerPeople, 50)
  assert.equal(c.maxConstituentDropPercent, 10)
  assert.equal(c.policyFile, 'policy.json')
  assert.equal(c.imageRevision, null)
})

test('loadConfig reads the step 3 settings and rejects non-numbers by name', () => {
  const c = loadConfig({ ...full, CIRCUIT_BREAKER_PEOPLE: '7', MAX_CONSTITUENT_DROP_PERCENT: '3', POLICY_FILE: 'x.json', IMAGE_REVISION: 'abc123' })
  assert.deepEqual([c.circuitBreakerPeople, c.maxConstituentDropPercent, c.policyFile, c.imageRevision], [7, 3, 'x.json', 'abc123'])
  assert.throws(() => loadConfig({ ...full, CIRCUIT_BREAKER_PEOPLE: 'abc' }), /CIRCUIT_BREAKER_PEOPLE/)
  assert.throws(() => loadConfig({ ...full, MAX_CONSTITUENT_DROP_PERCENT: '-1' }), /MAX_CONSTITUENT_DROP_PERCENT/)
})
