import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, allowedForLgl } from '../../src/lgl-vg/config.js'

const full = {
  LGL_API_KEY: 'k', LGL_MEMBERSHIP_FUND_ID: '11', LGL_PAYPAL_PAYMENT_TYPE_ID: '22',
  VG_API_URL: 'https://vg.example.org/api/', VG_OIDC_URL: 'https://auth.example.org/realms/vg/',
  VG_CLIENT_ID: 'vg-sync', VG_CLIENT_SECRET: 's',
}

test('loadConfig reads values, converts ids to numbers, strips trailing slashes, applies defaults', () => {
  const c = loadConfig(full)
  assert.deepEqual(c.lgl, { apiKey: 'k', mock: null, membershipFundId: 11, paypalPaymentTypeId: 22 })
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

test('defaults for the service', () => {
  const c = loadConfig(full)
  assert.equal(c.writeVg, false)
  assert.equal(c.fullPassUtc, '07:00')
  assert.equal(c.outDir, 'out')
  assert.equal(c.decisionsKeepDays, 30)
  assert.equal(c.passTimeoutMinutes, 30)
})

test('WRITE_VG is on only for "true"', () => {
  assert.equal(loadConfig({ ...full, WRITE_VG: 'true' }).writeVg, true)
  for (const v of ['TRUE', '1', 'yes', '']) assert.equal(loadConfig({ ...full, WRITE_VG: v }).writeVg, false)
})

test('FULL_PASS_UTC must be HH:MM', () => {
  for (const v of ['7:00', '24:00', '07:60', '0700']) {
    assert.throws(() => loadConfig({ ...full, FULL_PASS_UTC: v }), /FULL_PASS_UTC must be HH:MM/)
  }
  for (const v of ['23:59', '00:00']) assert.equal(loadConfig({ ...full, FULL_PASS_UTC: v }).fullPassUtc, v)
})

test('PASS_TIMEOUT_MINUTES and DECISIONS_KEEP_DAYS are positive whole numbers', () => {
  for (const name of ['PASS_TIMEOUT_MINUTES', 'DECISIONS_KEEP_DAYS']) {
    assert.throws(() => loadConfig({ ...full, [name]: '0' }), new RegExp(name))
    assert.throws(() => loadConfig({ ...full, [name]: 'x' }), new RegExp(name))
  }
  const c = loadConfig({ ...full, PASS_TIMEOUT_MINUTES: '5', DECISIONS_KEEP_DAYS: '9' })
  assert.deepEqual([c.passTimeoutMinutes, c.decisionsKeepDays], [5, 9])
})

test('PASS_TIMEOUT_MINUTES is capped at 1440 (a day)', () => {
  assert.equal(loadConfig({ ...full, PASS_TIMEOUT_MINUTES: '1440' }).passTimeoutMinutes, 1440)
  assert.throws(() => loadConfig({ ...full, PASS_TIMEOUT_MINUTES: '1441' }), /PASS_TIMEOUT_MINUTES.*1440/)
  assert.throws(() => loadConfig({ ...full, PASS_TIMEOUT_MINUTES: '40000' }), /PASS_TIMEOUT_MINUTES.*1440/)
})

test('CHECK_TIMEOUT_MINUTES defaults to 5 and rejects 61', () => {
  assert.equal(loadConfig(full).checkTimeoutMinutes, 5)
  assert.equal(loadConfig({ ...full, CHECK_TIMEOUT_MINUTES: '60' }).checkTimeoutMinutes, 60)
  assert.throws(() => loadConfig({ ...full, CHECK_TIMEOUT_MINUTES: '61' }), /CHECK_TIMEOUT_MINUTES/)
  assert.throws(() => loadConfig({ ...full, CHECK_TIMEOUT_MINUTES: '0' }), /CHECK_TIMEOUT_MINUTES/)
})

const base = full

test('WRITE_LGL needs WRITE_VG', () => {
  assert.throws(() => loadConfig({ ...base, WRITE_LGL: 'true' }), /WRITE_LGL=true requires WRITE_VG=true/)
  assert.equal(loadConfig({ ...base, WRITE_VG: 'true', WRITE_LGL: 'true' }).writeLgl, true)
  assert.equal(loadConfig(base).writeLgl, false)
})

test('LGL_WRITE_ALLOW: unset is none, all is all, a list is ids', () => {
  assert.equal(allowedForLgl(loadConfig(base), '101'), false)
  assert.equal(allowedForLgl(loadConfig({ ...base, LGL_WRITE_ALLOW: 'all' }), '101'), true)
  const c = loadConfig({ ...base, LGL_WRITE_ALLOW: ' 101, 202 ' })
  assert.equal(allowedForLgl(c, 101), true)
  assert.equal(allowedForLgl(c, '303'), false)
})

test('LGL_WRITE_ALLOW refuses anything but ids or all', () => {
  assert.throws(() => loadConfig({ ...base, LGL_WRITE_ALLOW: '101,abc' }), /LGL_WRITE_ALLOW/)
})

test('LGL_MOCK names a state file and makes LGL_API_KEY optional', () => {
  const { LGL_API_KEY, ...rest } = full
  assert.throws(() => loadConfig(rest), /LGL_API_KEY/)
  const c = loadConfig({ ...rest, LGL_MOCK: ' out/mock.json ' })
  assert.deepEqual([c.lgl.mock, c.lgl.apiKey], ['out/mock.json', ''])
})
