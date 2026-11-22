import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../../src/vg-mailchimp/config.js'

const base = { MAILCHIMP_API_KEY: 'k-us1', MAILCHIMP_LIST_ID: 'abc', MAILCHIMP_LIST_NAME: 'Main',
  VG_API_URL: 'https://vg.example.org/api', VG_OIDC_URL: 'https://kc.example.org/realms/vg',
  VG_CLIENT_ID: 'vg-mailchimp', VG_CLIENT_SECRET: 's' }

test('defaults', () => {
  const c = loadConfig(base)
  assert.deepEqual([c.writeAdd, c.writeArchive, c.archiveAfterDays, c.planLimit, c.limitMargin, c.maxAdd, c.maxArchive, c.minCohort, c.runUtc, c.runTimeoutMinutes, c.recordsKeepDays, c.outDir],
    [false, false, 30, 5000, 100, 50, 50, 500, '08:00', 30, 30, 'out'])
  assert.equal(c.vg.scope, 'vg')
})

test('missing variables are named', () => assert.throws(() => loadConfig({}), /MAILCHIMP_API_KEY.*MAILCHIMP_LIST_ID.*MAILCHIMP_LIST_NAME.*VG_API_URL/))

test('MAILCHIMP_MOCK removes the need for an API key', () => {
  const { MAILCHIMP_API_KEY, ...rest } = base
  assert.equal(loadConfig({ ...rest, MAILCHIMP_MOCK: 'mc.json' }).mailchimp.mock, 'mc.json')
})

test('switches are true only for "true"', () => {
  assert.equal(loadConfig({ ...base, WRITE_MAILCHIMP_ADD: 'yes' }).writeAdd, false)
  assert.equal(loadConfig({ ...base, WRITE_MAILCHIMP_ARCHIVE: 'true' }).writeArchive, true)
})

test('bad values are refused', () => {
  assert.throws(() => loadConfig({ ...base, MAILCHIMP_RUN_UTC: '8:00' }), /HH:MM/)
  assert.throws(() => loadConfig({ ...base, LIMIT_MARGIN: '-1' }), /whole number/)
  assert.throws(() => loadConfig({ ...base, RUN_TIMEOUT_MINUTES: '1441' }), /at most 1440/)
  assert.throws(() => loadConfig({ ...base, VG_API_URL: 'http://vg.example.org' }), /https/)
  assert.throws(() => loadConfig({ ...base, LIMIT_MARGIN: '5000' }), /LIMIT_MARGIN must be below PLAN_LIMIT/)
})
