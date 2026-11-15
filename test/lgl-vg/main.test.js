import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { run, envFileFrom } from '../../src/lgl-vg/main.js'

const ENV = {
  LGL_API_KEY: 'lgl-key',
  LGL_MEMBERSHIP_FUND_ID: '5',
  LGL_PAYPAL_PAYMENT_TYPE_ID: '2',
  VG_API_URL: 'https://vg.example.org/api',
  VG_OIDC_URL: 'https://auth.example.org/realms/vg',
  VG_CLIENT_ID: 'vg-sync',
  VG_CLIENT_SECRET: 's3cret',
}
const NOW = Date.parse('2026-11-11T10:20:30.456Z')
const STAMP = '2026-11-11T10-20-30-456Z'

const constituents = [
  {
    id: 1, first_name: 'Jane', last_name: 'Doe', nick_name: null, suffix: null, is_deceased: false, is_org: false,
    email_addresses: [{ address: 'jane@example.org', is_preferred: true, not_current: false }],
    street_addresses: [{ street: '12 Elm St', city: 'Providence', state: 'RI', zip5: '02903', postal_code: '02903', is_preferred: true, not_current: false }],
    phone_numbers: [],
  },
]
const gifts = [{ id: 1, constituent_id: 1, received_date: '2025-06-01', gift_type_id: 1, fund_id: 9, payment_type_id: 1 }]
const persons = [
  {
    personId: 10, deceased: false, email: 'jane@example.org', phone: null,
    donor: { lglConstituentId: '1', lastGiftDate: '2025-06-01' },
    detail: { firstName: 'Jane', lastName: 'Doe', suffix: null, nickname: null, street: '14 Elm St', unit: null, city: 'Providence', state: 'RI', zip: '02903', deceasedDate: null },
  },
]

function harness({ lgl = true, signIn = true, files = {}, vgUser = {}, needsAck = false, personsStatus = 200, personsBody } = {}) {
  const calls = []
  const out = []
  const written = []
  const posts = []
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url)
    calls.push(u.href)
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status })
    if (u.hostname === 'auth.example.org') return signIn ? json({ access_token: 't', expires_in: 300 }) : json({ error: 'bad' }, 401)
    if (u.hostname === 'vg.example.org') {
      if (u.pathname === '/api/user') {
        const user = { userId: 1, username: 'service-account-vg-sync', ...vgUser }
        if (u.searchParams.get('projection') === 'privacyStatus') user.privacyStatus = { needsAck, pendingRulesId: needsAck ? 4 : null }
        return json(user)
      }
      if (u.pathname === '/api/privacy/rules') return json({ id: 4, content: 'Rules' })
      if (u.pathname === '/api/privacy/acknowledgements') {
        posts.push(JSON.parse(init.body))
        return json({ rulesId: 4 }, 201)
      }
      if (u.pathname === '/api/sync/fields' || u.pathname === '/api/sync/holds' || u.pathname === '/api/sync/runs') return json([])
      if (u.pathname === '/api/persons') return json(personsBody ?? persons, personsStatus)
    }
    if (u.hostname === 'api.littlegreenlight.com') {
      if (!lgl) throw new Error('LGL must not be called')
      const items = u.pathname.endsWith('/constituents/search') ? constituents : gifts
      return json({ total_items: items.length, items })
    }
    return json({}, 404)
  }
  const deps = {
    env: ENV,
    fetchImpl,
    now: () => NOW,
    sleep: async () => {},
    stdout: (t) => out.push(t),
    writeFile: async (p, text) => written.push({ path: p, text }),
    readFile: async (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`)
      return files[p]
    },
  }
  return { deps, calls, out, written, posts }
}

test('report signs in, pulls both systems, prints the summary and writes the detail file', async () => {
  const h = harness()
  assert.equal(await run(['report'], h.deps), 0)
  const text = h.out.join('\n')
  const lines = text.trimEnd().split('\n')
  const summary = JSON.parse(lines.slice(0, -1).join('\n'))
  assert.equal(summary.counts.constituents, 1)
  assert.equal(h.written.length, 1)
  assert.equal(h.written[0].path, `out/report-${STAMP}.jsonl`)
  assert.match(lines.at(-1), new RegExp(`out/report-${STAMP}\\.jsonl`))
  for (const l of h.written[0].text.trimEnd().split('\n')) JSON.parse(l)
  assert.ok(h.calls.findIndex((c) => c.includes('/api/user')) < h.calls.findIndex((c) => c.includes('littlegreenlight')))
})

test('report with --snapshot makes no request to LGL', async () => {
  const h = harness({ lgl: false, files: { 'snap.json': JSON.stringify({ pulledAt: 'x', constituents, gifts }) } })
  assert.equal(await run(['report', '--snapshot', 'snap.json'], h.deps), 0)
  assert.equal(h.calls.some((c) => c.includes('littlegreenlight')), false)
  assert.equal(h.written.length, 1)
})

test('report with --save-snapshot writes the pull under out/', async () => {
  const h = harness()
  assert.equal(await run(['report', '--out', 'o', '--save-snapshot'], h.deps), 0)
  const snap = h.written.find((w) => w.path === `o/lgl-snapshot-${STAMP}.json`)
  assert.ok(snap)
  const body = JSON.parse(snap.text)
  assert.equal(body.pulledAt, '2026-11-11T10:20:30.456Z')
  assert.equal(body.constituents.length, 1)
  assert.equal(body.gifts.length, 1)
  assert.ok(h.written.some((w) => w.path === `o/report-${STAMP}.jsonl`))
})

test('a sign-in failure returns 1, prints REPORT FAILED, and never calls LGL', async () => {
  const h = harness({ signIn: false, lgl: false })
  assert.equal(await run(['report'], h.deps), 1)
  assert.match(h.out.join('\n'), /^REPORT FAILED: /)
  assert.equal(h.calls.some((c) => c.includes('littlegreenlight')), false)
  assert.equal(h.written.length, 0)
})

test('standard output contains no fixture name, email or street', async () => {
  const h = harness()
  await run(['report'], h.deps)
  const text = h.out.join('\n')
  for (const s of ['Jane', 'Doe', 'Elm']) {
    assert.equal(text.includes(s), false, s)
  }
  assert.equal(text.includes('jane@'), false)
})

test('an unknown command returns 2', async () => {
  const h = harness()
  assert.equal(await run(['frobnicate'], h.deps), 2)
  assert.match(h.out.join('\n'), /report[\s\S]*setup/)
})

test('setup prints who it signed in as', async () => {
  const h = harness()
  await run(['setup'], h.deps)
  assert.equal(h.out[0], 'Signed in as service-account-vg-sync (user id 1)')
})

test('setup stops at an owed acknowledgement when the flag is absent, and posts nothing', async () => {
  const h = harness({ needsAck: true })
  assert.equal(await run(['setup'], h.deps), 1)
  assert.ok(h.out.includes('Privacy acknowledgement is owed. Run again with --acknowledge-privacy.'))
  assert.deepEqual(h.posts, [])
  assert.equal(h.calls.some((c) => c.includes('/api/persons')), false)
})

test('setup with --acknowledge-privacy reads the rules and posts their id', async () => {
  const h = harness({ needsAck: true })
  assert.equal(await run(['setup', '--acknowledge-privacy'], h.deps), 0)
  assert.deepEqual(h.posts, [{ rulesId: 4 }])
  assert.ok(h.out.includes('Privacy acknowledgement recorded.'))
  assert.equal(h.out.at(-1), 'SETUP OK')
})

test('setup with --acknowledge-privacy posts nothing when no acknowledgement is owed', async () => {
  const h = harness()
  assert.equal(await run(['setup', '--acknowledge-privacy'], h.deps), 0)
  assert.deepEqual(h.posts, [])
})

test('setup reports a missing role grant on 403 from /persons and returns 1', async () => {
  const h = harness({ personsStatus: 403, personsBody: { error: 'forbidden' } })
  assert.equal(await run(['setup'], h.deps), 1)
  assert.ok(h.out.includes('service-account-vg-sync has no role grant. Grant it the Staff role at federation level in VG, then run setup again.'))
  assert.equal(h.out.includes('SETUP OK'), false)
})

test('setup reports the donor:read problem and returns 1', async () => {
  const h = harness({ personsBody: [{ personId: 1, detail: {} }] })
  assert.equal(await run(['setup'], h.deps), 1)
  assert.match(h.out.at(-1), /donor:read/)
})

test('setup prints SETUP OK when nothing is owed and persons can be read', async () => {
  const h = harness()
  assert.equal(await run(['setup'], h.deps), 0)
  assert.equal(h.out.at(-1), 'SETUP OK')
  assert.deepEqual(h.posts, [])
})

test('setup with an unknown option or a sign-in failure returns 1 with SETUP FAILED', async () => {
  const h = harness()
  assert.equal(await run(['setup', '--bogus'], h.deps), 1)
  assert.match(h.out.at(-1), /^SETUP FAILED: Unknown option --bogus/)
  const h2 = harness({ signIn: false })
  assert.equal(await run(['setup'], h2.deps), 1)
  assert.match(h2.out.at(-1), /^SETUP FAILED: /)
})

test('a malformed snapshot fails without quoting the file', async () => {
  const h = harness({ lgl: false, files: { 'snap.json': '{"name": "Zelda Quimby" oops' } })
  assert.equal(await run(['report', '--snapshot', 'snap.json'], h.deps), 1)
  const text = h.out.join('\n')
  assert.match(text, /^REPORT FAILED: Snapshot snap\.json is not valid JSON/)
  assert.equal(text.includes('Zelda'), false)
})
test('a snapshot without constituents or gifts fails', async () => {
  const h = harness({ lgl: false, files: { 'snap.json': '{}' } })
  assert.equal(await run(['report', '--snapshot', 'snap.json'], h.deps), 1)
  assert.match(h.out.join('\n'), /^REPORT FAILED: Snapshot snap\.json has no constituents or gifts/)
})
test('an unknown report option returns 1 with REPORT FAILED', async () => {
  const h = harness()
  assert.equal(await run(['report', '--bogus'], h.deps), 1)
  assert.match(h.out.join('\n'), /^REPORT FAILED: /)
})
test('--out with no value returns 1 with REPORT FAILED', async () => {
  const h = harness()
  assert.equal(await run(['report', '--out'], h.deps), 1)
  assert.match(h.out.join('\n'), /^REPORT FAILED: /)
})

test('usage lists the service and --once full', async () => {
  const h = harness()
  assert.equal(await run(['frobnicate'], h.deps), 2)
  const text = h.out.join('\n')
  assert.match(text, /main\.js\n/)
  assert.match(text, /main\.js --once full /)
})

test('the bare full command is gone', async () => {
  const h = harness({ lgl: false })
  assert.equal(await run(['full'], h.deps), 2)
  assert.match(h.out.join('\n'), /^Usage:/)
  assert.deepEqual(h.calls, [])
})

test('--once lgl-check and --once vg-check are refused until step 6', async () => {
  for (const kind of ['lgl-check', 'vg-check']) {
    const h = harness({ lgl: false })
    assert.equal(await run(['--once', kind], h.deps), 2)
    assert.deepEqual(h.out, ['The VG and LGL checks arrive in step 6.'])
    assert.deepEqual(h.calls, [])
  }
})

test('--once with no kind or an unknown kind prints usage', async () => {
  for (const argv of [['--once'], ['--once', 'report']]) {
    const h = harness({ lgl: false })
    assert.equal(await run(argv, h.deps), 2)
    assert.match(h.out.join('\n'), /^Usage:/)
  }
})

test('--once full --snapshot with --write-vg exits 2 before any request', async () => {
  const h = harness({ lgl: false })
  assert.equal(await run(['--once', 'full', '--snapshot', 'x', '--write-vg'], h.deps), 2)
  assert.match(h.out.join('\n'), /snapshot cannot be used to write/)
  assert.deepEqual(h.calls, [])
})

test('--once full --max-people must be a positive whole number', async () => {
  for (const v of ['0', '-1', '2.5', 'abc']) {
    const h = harness()
    assert.equal(await run(['--once', 'full', '--max-people', v], h.deps), 2, v)
    assert.deepEqual(h.calls, [])
  }
})

test('--once full dry run from a snapshot reads the policy, calls no LGL and writes the decisions', async () => {
  const policyText = (await import('node:fs')).readFileSync(new URL('../../policy.json', import.meta.url), 'utf8')
  const h = harness({
    lgl: false,
    files: { snap: JSON.stringify({ constituents, gifts }), 'policy.json': policyText },
  })
  assert.equal(await run(['--once', 'full', '--snapshot', 'snap'], h.deps), 0)
  assert.match(h.out.at(-1), /^PASS OK full dry-run /)
  assert.equal(h.written.length, 1)
  assert.match(h.written[0].path, new RegExp(`^out/full-${STAMP}\\.jsonl$`))
})

test('envFileFrom defaults to .env and leaves argv alone', () => {
  assert.deepEqual(envFileFrom(['full']), { file: '.env', explicit: false, rest: ['full'] })
})

test('envFileFrom strips --env <file> and marks it explicit', () => {
  assert.deepEqual(envFileFrom(['full', '--env', '.env.harness', '--write-vg']), {
    file: '.env.harness',
    explicit: true,
    rest: ['full', '--write-vg'],
  })
})

test('envFileFrom throws when --env has no file', () => {
  assert.throws(() => envFileFrom(['full', '--env']), /--env needs a file/)
})

const importRun = (o = {}) => JSON.stringify({
  target: 'prod', executed: true,
  actions: [
    { key: '1', lglId: '1', kind: 'skip', reason: 'Staff chose Skip', lastGiftDate: '2025-06-01' }, // linked today (persons fixture)
    { key: '2', lglId: '2', kind: 'skip', reason: 'Staff chose Skip', lastGiftDate: '2025-06-01' },
    { key: '3', lglId: '3', kind: 'hold', reason: 'Not confirmed on the Work list', lastGiftDate: '2025-06-01' },
  ],
  ...o,
})
const withHoldPosts = (h) => {
  const posted = []
  const inner = h.deps.fetchImpl
  h.deps.fetchImpl = async (url, init = {}) => {
    if (init.method === 'POST' && new URL(url).pathname === '/api/sync/holds') posted.push(...JSON.parse(init.body))
    return inner(url, init)
  }
  return posted
}

test('seed-import: dry by default, prints counts only, loads nothing', async () => {
  const h = harness({ lgl: false, files: { run: importRun() } })
  const posted = withHoldPosts(h)
  assert.equal(await run(['seed-import', '--file', 'run'], h.deps), 0)
  assert.deepEqual(posted, [])
  assert.match(h.out.at(-1), /^SEED OK dry-run loaded=0 planned=2$/)
})

test('seed-import --write-vg posts the holds; a dry-run import file or no --file is refused', async () => {
  const h = harness({ lgl: false, files: { run: importRun() } })
  const posted = withHoldPosts(h)
  assert.equal(await run(['seed-import', '--file', 'run', '--write-vg'], h.deps), 0)
  assert.deepEqual(posted.map((x) => [x.lglConstituentId, x.reason, x.state]), [['2', 'import-skip', 'dismissed'], ['3', 'import-hold', 'open']])
  assert.match(h.out.at(-1), /^SEED OK write-vg loaded=2 planned=2$/)

  const dry = harness({ lgl: false, files: { run: importRun({ executed: false }) } })
  assert.equal(await run(['seed-import', '--file', 'run', '--write-vg'], dry.deps), 1)
  assert.match(dry.out.at(-1), /^SEED FAILED .*dry run of the import/)
  assert.equal(await run(['seed-import'], harness().deps), 2)
})

const policyText = () => readFileSync(new URL('../../policy.json', import.meta.url), 'utf8')

function serviceHarness(o = {}) {
  const h = harness({ files: { 'policy.json': policyText() }, ...o })
  const handlers = {}
  let registered
  const ready = new Promise((resolve) => { registered = resolve })
  const timers = new Set()
  let id = 0
  h.deps.onSignal = (name, fn) => { handlers[name] = fn; if (handlers.SIGTERM && handlers.SIGINT) registered() }
  h.deps.setTimer = () => { timers.add(++id); return id }
  h.deps.clearTimer = (i) => { timers.delete(i) }
  h.deps.fs = { readdir: async () => [], stat: async () => ({ mtimeMs: NOW }), unlink: async () => {} }
  return { ...h, handlers, ready, timers }
}

test('no command starts the service and SIGTERM stops it', async () => {
  const h = serviceHarness()
  const done = run([], h.deps)
  await h.ready
  assert.deepEqual(h.out.slice(0, 3), [
    'STARTUP VG signed in as service-account-vg-sync',
    'STARTUP LGL reached',
    'STARTUP scheduler started write-vg=off nightly=07:00Z',
  ])
  h.handlers.SIGTERM()
  assert.equal(await done, 0)
  const stopping = h.out.indexOf('STOPPING')
  assert.ok(stopping > 2, h.out.join('\n'))
  assert.equal(h.out.at(-1), 'STOPPED')
  assert.equal(h.timers.size, 0, 'no timer is left armed')
  assert.ok(h.calls.some((c) => c.includes('/constituents.json?limit=1')), 'the LGL probe ran')
})

test('a second signal while stopping does nothing more', async () => {
  const h = serviceHarness()
  const done = run([], h.deps)
  await h.ready
  h.handlers.SIGINT()
  h.handlers.SIGTERM()
  assert.equal(await done, 0)
  assert.equal(h.out.filter((l) => l === 'STOPPING').length, 1)
  assert.equal(h.out.filter((l) => l === 'STOPPED').length, 1)
})

test('the service prints STARTUP FAILED and returns 1 for a config error', async () => {
  const h = serviceHarness({ lgl: false })
  h.deps.env = { ...ENV, VG_CLIENT_SECRET: '' }
  assert.equal(await run([], h.deps), 1)
  assert.deepEqual(h.out, ['STARTUP FAILED Missing environment variables: VG_CLIENT_SECRET'])
  assert.deepEqual(h.calls, [])
})

test('the service prints STARTUP FAILED and returns 1 for a missing policy file', async () => {
  const h = serviceHarness({ lgl: false, files: {} })
  assert.equal(await run([], h.deps), 1)
  assert.match(h.out.at(-1), /^STARTUP FAILED /)
  assert.deepEqual(h.calls, [])
})

test('the service returns 1 after a refused sign-in, tried once', async () => {
  const h = serviceHarness({ lgl: false, signIn: false })
  assert.equal(await run([], h.deps), 1)
  assert.match(h.out.at(-1), /^STARTUP FAILED /)
  assert.equal(h.calls.filter((c) => c.includes('auth.example.org')).length, 1)
})
