import { test } from 'node:test'
import assert from 'node:assert/strict'
import { submission } from './fixtures/submissions.js'
import { run, envFileFrom } from '../../src/jotform-vg/main.js'

const state = { submissions: [], form: { status: 'ENABLED' } }
const env = (o = {}) => ({
  JOTFORM_MOCK: 'state.json', JOTFORM_FORM_ID: '250001', VG_API_URL: 'https://vg.example.org/api', VG_OIDC_URL: 'https://auth.example.org/realms/vg',
  VG_CLIENT_ID: 'c', VG_CLIENT_SECRET: 's', ...o,
})

function fakeVg(over = {}) {
  return {
    whoAmI: async () => ({ username: 'vg-jotform', userId: 9 }),
    privacyStatus: async () => ({ needsAck: false }),
    currentPrivacyRules: async () => ({ id: 3 }),
    acknowledgePrivacy: async () => {},
    getState: async () => ({ cursor: '2026-11-01 00:00:00', count: 1 }),
    listPersons: async () => [], listVillages: async () => [], listNameMatches: async () => [],
    listSubmissions: async () => [], listOpenHolds: async () => [],
    putSubmission: async () => {}, deleteSubmission: async () => {}, putHolds: async () => {},
    ...over,
  }
}

function deps(o = {}) {
  const out = []
  const acked = []
  const d = {
    env: env(), now: () => Date.parse('2026-11-26T12:00:00Z'), stdout: (t) => out.push(t),
    readFile: async () => JSON.stringify(state), writeFile: async () => {},
    vg: fakeVg({ acknowledgePrivacy: async (id) => { acked.push(id) } }),
    ...o,
  }
  return { d, out, acked }
}

test('--once change with a mock and a fake VG prints one OK line and resolves 0', async () => {
  const { d, out } = deps()
  assert.equal(await run(['--once', 'change'], d), 0)
  assert.equal(out.filter((l) => l.startsWith('JOTFORM OK change')).length, 1)
  assert.ok(out.some((l) => l.startsWith('JOTFORM MOCK ')))
  assert.ok(out.includes('JOTFORM DRY RUN: nothing is written to VG'))
})

test('--once with no kind or a bad kind prints usage and resolves 2', async () => {
  const { d, out } = deps()
  assert.equal(await run(['--once'], d), 2)
  assert.equal(await run(['--once', 'weekly'], d), 2)
  assert.match(out[0], /^Usage:/)
})

test('--once: a failure prints a sanitized line and resolves 1', async () => {
  const { d, out } = deps({ vg: fakeVg({ listPersons: async () => { throw new Error('VG GET /persons → 500: {"n":"Jane Doe"}') } }) })
  assert.equal(await run(['--once', 'full'], d), 1)
  assert.equal(out.at(-1), 'JOTFORM FAILED full: VG GET /persons → 500')
  assert.ok(!out.join('\n').includes('Jane'))
})

test('--once: a missing setting is reported and resolves 1', async () => {
  const { d, out } = deps({ env: env({ VG_CLIENT_ID: '' }) })
  assert.equal(await run(['--once', 'full'], d), 1)
  assert.equal(out.at(-1), 'JOTFORM FAILED full: Missing environment variables: VG_CLIENT_ID')
})

test('setup signs in, checks the grant and JotForm, and prints SETUP OK', async () => {
  const { d, out } = deps()
  assert.equal(await run(['setup'], d), 0)
  assert.equal(out[0], 'Signed in as vg-jotform (user id 9)')
  assert.equal(out.at(-1), 'SETUP OK')
})

test('setup: privacy owed needs --acknowledge-privacy', async () => {
  const { d, out, acked } = deps({ vg: fakeVg({ privacyStatus: async () => ({ needsAck: true }) }) })
  assert.equal(await run(['setup'], d), 1)
  assert.match(out.at(-1), /acknowledge-privacy/)
  const r = deps({ vg: fakeVg({ privacyStatus: async () => ({ needsAck: true }), acknowledgePrivacy: async (id) => acked.push(id) }) })
  assert.equal(await run(['setup', '--acknowledge-privacy'], r.d), 0)
  assert.ok(r.out.includes('Privacy acknowledgement recorded.'))
})

test('setup: a 403 on the state route says to grant the role', async () => {
  const { d, out } = deps({ vg: fakeVg({ getState: async () => { throw Object.assign(new Error('VG GET /friends/sync/state → 403: x'), { status: 403 }) } }) })
  assert.equal(await run(['setup'], d), 1)
  assert.equal(out.at(-1), 'vg-jotform has no role grant. Grant it the JotForm Sync role (role 10) at federation level in VG, then run setup again.')
})

test('setup: a JotForm failure resolves 1; a disabled form only warns', async () => {
  const bad = deps({ readFile: async () => JSON.stringify({ submissions: [], form: { status: 'DISABLED' } }) })
  assert.equal(await run(['setup'], bad.d), 0)
  assert.ok(bad.out.includes('JOTFORM WARN form status is DISABLED, not ENABLED'))
  const gone = deps({ env: env({ JOTFORM_FORM_ID: '250001', JOTFORM_MOCK: undefined, JOTFORM_API_KEY: 'k' }), fetchImpl: async () => { throw new TypeError('fetch failed') } })
  assert.equal(await run(['setup'], gone.d), 1)
  assert.match(gone.out.at(-1), /^JotForm not reached: network error: fetch failed/)
})

test('service: dry run and mock lines, signal stops with 0', async () => {
  const { d, out } = deps()
  const handlers = {}
  d.onSignal = (n, fn) => { handlers[n] = fn }
  d.setTimer = () => 1
  d.clearTimer = () => {}
  d.sleep = async () => {}
  const p = run([], d)
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
  assert.ok(out.includes('JOTFORM DRY RUN: nothing is written to VG'))
  assert.ok(out.some((l) => l.startsWith('JOTFORM MOCK ')))
  assert.ok(out.includes('STARTUP JotForm form reached'))
  handlers.SIGTERM()
  assert.equal(await p, 0)
  assert.deepEqual(out.slice(-2), ['STOPPING', 'STOPPED'])
})

test('service: a fatal pass error resolves 1', async () => {
  const { d, out } = deps({ vg: fakeVg({ listPersons: async () => { throw Object.assign(new Error('VG GET /persons → 403: x'), { status: 403 }) } }) })
  d.onSignal = () => {}
  d.setTimer = () => 1
  d.clearTimer = () => {}
  d.sleep = async () => {}
  assert.equal(await run([], d), 1)
  assert.ok(out.includes('JOTFORM FAILED full: VG GET /persons → 403'))
})

test('envFileFrom takes --env anywhere', () => {
  assert.deepEqual(envFileFrom(['--once', '--env', 'x.env', 'full']), { file: 'x.env', explicit: true, rest: ['--once', 'full'] })
  assert.throws(() => envFileFrom(['--env']), /needs a file/)
})

test('--once: a timeout or signal refuses further VG calls and the pass goes quiet', async () => {
  for (const how of ['timeout', 'signal']) {
    let release
    const gate = new Promise((r) => { release = r })
    const writes = []
    const { d, out } = deps({
      readFile: async () => JSON.stringify({ submissions: [submission()], form: { status: 'ENABLED' } }),
      vg: fakeVg({
        listPersons: async () => { await gate; return [] },
        putSubmission: async (id) => { writes.push(id) }, listSubmissions: async () => [],
      }),
    })
    const handlers = {}
    let fire
    d.onSignal = (n, fn) => { handlers[n] = fn }
    d.setTimer = (fn) => { fire = fn; return 1 }
    d.clearTimer = () => {}
    d.env = env({ WRITE_VG: 'true' })
    const p = run(['--once', 'full'], d)
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
    if (how === 'timeout') fire()
    else handlers.SIGINT()
    assert.equal(await p, 1)
    // The abandoned pass resumes and tries to write: refused (the write is never reached), nothing printed after FAILED.
    release()
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
    assert.equal(writes.length, 0, how)
    assert.match(out.at(-1), how === 'timeout' ? /^JOTFORM FAILED full: run timed out after 30 minutes$/ : /^JOTFORM FAILED full: run stopped$/)
  }
})
