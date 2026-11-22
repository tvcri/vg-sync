import { test } from 'node:test'
import assert from 'node:assert/strict'
import { run, envFileFrom, stamped } from '../../src/vg-mailchimp/main.js'

const ENV = {
  MAILCHIMP_MOCK: 'mock-state.json',
  MAILCHIMP_LIST_ID: 'list1',
  VG_API_URL: 'https://vg.example.org/api',
  VG_OIDC_URL: 'https://auth.example.org/realms/vg',
  VG_CLIENT_ID: 'vg-mailchimp',
  VG_CLIENT_SECRET: 's3cret',
  MIN_COHORT: '1',
  WRITE_MAILCHIMP_ADD: 'true',
  WRITE_MAILCHIMP_ARCHIVE: 'true',
}
const NOW = Date.parse('2026-11-21T10:20:30.456Z')

const person = (id, first, email) => ({
  personId: id, deceased: false, email, memberStatus: 'Active', volunteerStatus: null, donor: null,
  detail: { firstName: first, lastName: 'Doe' },
})
const TWO = [person(1, 'Jane', 'jane@example.org'), person(2, 'John', 'john@example.org')]

function harness({ persons = TWO, personsStatus = 200, members = [], needsAck = false } = {}) {
  const out = []
  const written = []
  const files = { 'mock-state.json': JSON.stringify({ list: { id: 'list1', name: 'Mock Audience' }, members }) }
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url)
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status })
    requests.push(`${init.method ?? 'GET'} ${u.hostname}${u.pathname}`)
    if (u.hostname === 'auth.example.org') return json({ access_token: 't', expires_in: 300 })
    if (u.pathname === '/api/user') {
      const user = { userId: 1, username: 'service-account-vg-mailchimp' }
      if (u.searchParams.get('projection') === 'privacyStatus') user.privacyStatus = { needsAck, pendingRulesId: needsAck ? 4 : null }
      return json(user)
    }
    if (u.pathname === '/api/privacy/rules') return json({ id: 4 })
    if (u.pathname === '/api/privacy/acknowledgements') return json({ rulesId: 4 }, 201)
    if (u.pathname === '/api/persons') return json(personsStatus === 200 ? persons : { error: 'no' }, personsStatus)
    return json({}, 404)
  }
  const state = () => JSON.parse(files['mock-state.json'])
  const deps = {
    env: ENV, fetchImpl, now: () => NOW, sleep: async () => {}, stdout: (t) => out.push(t),
    writeFile: async (p, text) => { written.push({ path: p, text }); if (p in files) files[p] = text },
    readFile: async (p) => { if (!(p in files)) throw new Error(`ENOENT ${p}`); return files[p] },
    onSignal: () => {},
  }
  return { deps, out, written, files, state, requests }
}

test('envFileFrom takes --env out of the arguments', () => {
  assert.deepEqual(envFileFrom(['--once', '--env', 'x.env']), { file: 'x.env', explicit: true, rest: ['--once'] })
  assert.deepEqual(envFileFrom([]), { file: '.env', explicit: false, rest: [] })
  assert.throws(() => envFileFrom(['--env']), /needs a file/)
})

test('stamped puts the time on each line', () => {
  const lines = []
  stamped((t) => lines.push(t), () => NOW)('a\nb')
  assert.deepEqual(lines, ['2026-11-21T10:20:30.456Z a\n2026-11-21T10:20:30.456Z b'])
})

test('an unknown command prints usage and returns 2', async () => {
  const h = harness()
  assert.equal(await run(['frobnicate'], h.deps), 2)
  assert.match(h.out[0], /^Usage:/)
  assert.equal(await run(['--once', '--bogus'], h.deps), 2)
  assert.equal(h.requests.length, 0)
})

test('--once with no flags writes nothing, even with the WRITE switches on', async () => {
  const h = harness()
  assert.equal(await run(['--once'], h.deps), 0)
  assert.equal(h.state().members.length, 0)
  const summary = h.out.find((l) => l.startsWith('MAILCHIMP OK '))
  assert.match(summary, /adds=2 /)
  assert.match(summary, /writes=add:off,archive:off/)
  assert.ok(h.written.some((w) => w.path.startsWith('out/mailchimp-')))
})

test('--once --write-add --max-add 1 with two to add: none added, cap printed', async () => {
  const h = harness()
  assert.equal(await run(['--once', '--write-add', '--max-add', '1'], h.deps), 0)
  assert.ok(h.out.includes('MAILCHIMP CAP add=2 max=1'), h.out.join('\n'))
  assert.equal(h.state().members.length, 0)
})

test('--once --write-add --max-add 2 adds both', async () => {
  const h = harness()
  assert.equal(await run(['--once', '--write-add', '--max-add', '2'], h.deps), 0)
  assert.equal(h.state().members.length, 2)
  assert.ok(h.state().members.every((m) => m.status === 'subscribed'))
})

test('--out overrides the output directory', async () => {
  const h = harness()
  assert.equal(await run(['--once', '--out', 'elsewhere'], h.deps), 0)
  assert.ok(h.written.some((w) => w.path.startsWith('elsewhere/mailchimp-')))
})

test('--once returns 1 when the run fails', async () => {
  const h = harness({ persons: [] })
  assert.equal(await run(['--once'], h.deps), 1)
  assert.ok(h.out.some((l) => l.startsWith('MAILCHIMP FAILED ')))
})

test('--once rejects a bad --max-add with exit 2', async () => {
  const h = harness()
  assert.equal(await run(['--once', '--max-add', 'x'], h.deps), 2)
})

test('--once aborts the run on SIGTERM', async () => {
  const h = harness()
  const handlers = {}
  h.deps.onSignal = (n, fn) => { handlers[n] = fn }
  const hang = new Promise(() => {})
  h.deps.fetchImpl = async (url, init) => (new URL(url).pathname === '/api/persons' ? hang : harness().deps.fetchImpl(url, init))
  const done = run(['--once'], h.deps)
  await new Promise((r) => setImmediate(r))
  handlers.SIGTERM()
  assert.equal(await done, 1)
})

test('setup prints the role to grant on a 403 from the person list', async () => {
  const h = harness({ personsStatus: 403 })
  assert.equal(await run(['setup'], h.deps), 1)
  assert.ok(h.out.includes('service-account-vg-mailchimp has no role grant. Grant it the Mailchimp Sync role at federation level in VG, then run setup again.'), h.out.join('\n'))
})

test('setup reports OK, and owes the acknowledgement only on request', async () => {
  const h = harness()
  assert.equal(await run(['setup'], h.deps), 0)
  assert.equal(h.out.at(-1), 'SETUP OK')
  const owed = harness({ needsAck: true })
  assert.equal(await run(['setup'], owed.deps), 1)
  assert.equal(owed.requests.some((r) => r.startsWith('POST vg.example.org')), false)
  assert.equal(await run(['setup', '--acknowledge-privacy'], owed.deps), 0)
  assert.ok(owed.requests.includes('POST vg.example.org/api/privacy/acknowledgements'))
})

test('service mode prints the STARTUP lines and stops on SIGTERM', async () => {
  const h = harness()
  const handlers = {}
  let ready
  const registered = new Promise((r) => { ready = r })
  h.deps.onSignal = (n, fn) => { handlers[n] = fn; if (handlers.SIGTERM && handlers.SIGINT) ready() }
  h.deps.setTimer = () => 1
  h.deps.clearTimer = () => {}
  h.deps.fs = { readdir: async () => [], stat: async () => ({ mtimeMs: NOW }), unlink: async () => {} }
  const done = run([], h.deps)
  await registered
  for (let i = 0; i < 1000 && !h.out.some((l) => l.startsWith('STARTUP scheduler')); i++) await new Promise((r) => setImmediate(r))
  const start = h.out.filter((l) => l.startsWith('STARTUP'))
  assert.deepEqual(start, [
    'STARTUP VG signed in as service-account-vg-mailchimp',
    'STARTUP Mailchimp audience Mock Audience reached',
    'STARTUP scheduler started write-add=on write-archive=on nightly=08:00Z',
  ])
  handlers.SIGTERM()
  assert.equal(await done, 0)
  assert.ok(h.out.indexOf('STOPPING') > 0)
  assert.equal(h.out.at(-1), 'STOPPED')
})

test('service mode: a config error prints STARTUP FAILED and returns 1', async () => {
  const h = harness()
  h.deps.env = { ...ENV, VG_CLIENT_SECRET: '' }
  assert.equal(await run([], h.deps), 1)
  assert.deepEqual(h.out, ['STARTUP FAILED Missing environment variables: VG_CLIENT_SECRET'])
})

test('--once --write-add works with no sleep injected (the entry point passes none of its own)', async () => {
  const h = harness()
  delete h.deps.sleep
  assert.equal(await run(['--once', '--write-add'], h.deps), 0)
  assert.equal(h.state().members.length, 2)
  assert.ok(h.state().members.every((m) => m.status === 'subscribed'))
  assert.ok(!h.out.some((l) => l.startsWith('MAILCHIMP FAILED')), h.out.join('\n'))
})
