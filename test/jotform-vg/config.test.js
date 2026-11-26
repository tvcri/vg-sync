import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../../src/jotform-vg/config.js'

const base = { JOTFORM_API_KEY: 'jk', JOTFORM_FORM_ID: '1234567890',
  VG_API_URL: 'https://vg.example.org/api', VG_OIDC_URL: 'https://kc.example.org/realms/vg',
  VG_CLIENT_ID: 'vg-jotform', VG_CLIENT_SECRET: 's' }

test('defaults', () => {
  const c = loadConfig(base)
  assert.deepEqual([c.writeVg, c.changeEveryMinutes, c.fullRunUtc, c.overlapMinutes, c.minFullPercent, c.dateAheadDays, c.dateBehindDays, c.runTimeoutMinutes, c.imageRevision],
    [false, 5, '08:00', 120, 90, 1, 90, 30, null])
  assert.equal(c.vg.scope, 'vg')
  assert.deepEqual(c.jotform, { apiKey: 'jk', formId: '1234567890', mock: null })
})

test('missing variables are named', () => {
  const { JOTFORM_FORM_ID, ...rest } = base
  assert.throws(() => loadConfig(rest), /^Error: Missing environment variables: JOTFORM_FORM_ID$/)
})

test('JOTFORM_MOCK removes the need for an API key', () => {
  const { JOTFORM_API_KEY, ...rest } = base
  assert.equal(loadConfig({ ...rest, JOTFORM_MOCK: 'jf.json' }).jotform.mock, 'jf.json')
})

test('WRITE_VG is true only for "true"', () => {
  assert.equal(loadConfig({ ...base, WRITE_VG: 'true' }).writeVg, true)
  assert.equal(loadConfig({ ...base, WRITE_VG: 'yes' }).writeVg, false)
})

test('bad values are refused', () => {
  assert.throws(() => loadConfig({ ...base, MIN_FULL_PERCENT: '101' }), /at most 100/)
  assert.throws(() => loadConfig({ ...base, MIN_FULL_PERCENT: '0' }), /positive/)
  assert.throws(() => loadConfig({ ...base, CHANGE_EVERY_MINUTES: '0' }), /positive/)
  assert.throws(() => loadConfig({ ...base, CHANGE_EVERY_MINUTES: '1441' }), /CHANGE_EVERY_MINUTES must be at most 1440/)
  assert.equal(loadConfig({ ...base, CHANGE_EVERY_MINUTES: '1440' }).changeEveryMinutes, 1440)
  assert.throws(() => loadConfig({ ...base, FULL_RUN_UTC: '8:00' }), /HH:MM/)
  assert.throws(() => loadConfig({ ...base, RUN_TIMEOUT_MINUTES: '1441' }), /at most 1440/)
  assert.throws(() => loadConfig({ ...base, VG_API_URL: 'http://vg.example.org' }), /https/)
})

test('OVERLAP_MINUTES must cover the repeated fall-back hour', () => {
  assert.throws(() => loadConfig({ ...base, OVERLAP_MINUTES: '59' }), /OVERLAP_MINUTES must be at least 60/)
  assert.equal(loadConfig({ ...base, OVERLAP_MINUTES: '60' }).overlapMinutes, 60)
})
