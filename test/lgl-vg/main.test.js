import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { run, envFileFrom } from '../../src/lgl-vg/main.js'
import { FIELDS, lglFields } from '../../src/lgl-vg/fields.js'

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

function harness({ lgl = true, signIn = true, files = {}, vgUser = {}, needsAck = false, personsStatus = 200, personsBody, runs = [], feed = { lastAuditId: 0, more: false, persons: [] }, lglUpdated = [], lglPull = constituents, lglGiftsUpdated = [], lglGiftsPull = gifts, memory = [], acceptWrites = false } = {}) {
  const requests = []
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
      requests.push(`${init.method ?? 'GET'} ${u.pathname}`)
      if (acceptWrites && init.method && init.method !== 'GET') return json(u.pathname === '/api/sync/runs' ? { runId: 1 } : {})
      if (u.pathname === '/api/sync/runs') return json(runs)
      if (u.pathname === '/api/sync/fields') return json(memory)
      if (u.pathname === '/api/sync/holds') return json([])
      if (u.pathname === '/api/sync/changes') return json(feed)
      if (u.pathname === '/api/persons') return json(personsBody ?? persons, personsStatus)
    }
    if (u.hostname === 'api.littlegreenlight.com') {
      if (!lgl) throw new Error('LGL must not be called')
      if (/\/constituents\/\d+\.json$/.test(u.pathname)) return json(constituents[0])
      if (/\/constituents\/\d+\/gifts\.json$/.test(u.pathname)) return json({ total_items: gifts.length, items: gifts })
      if (u.searchParams.get('q[]')?.startsWith('updated_from=')) {
        const upd = u.pathname.endsWith('/constituents/search') ? lglUpdated : lglGiftsUpdated
        return json({ total_items: upd.length, items: upd })
      }
      const items = u.pathname.endsWith('/constituents/search') ? lglPull : lglGiftsPull
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
  return { deps, calls, out, written, posts, requests }
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
  // Resolves once the scheduler has started (the handlers are registered before start-up); fails if
  // start-up failed or did not finish within a bounded number of turns.
  const started = async () => {
    await ready
    for (let turn = 0; turn < 1000; turn++) {
      const failed = h.out.find((l) => l.startsWith('STARTUP FAILED'))
      if (failed) assert.fail(`start-up failed: ${failed}`)
      if (h.out.some((l) => l.startsWith('STARTUP scheduler started'))) return
      await new Promise((r) => setImmediate(r))
    }
    assert.fail(`start-up did not finish; output so far:\n${h.out.join('\n')}`)
  }
  return { ...h, handlers, ready, started, timers }
}

test('no command starts the service and SIGTERM stops it', async () => {
  const h = serviceHarness()
  const done = run([], h.deps)
  await h.started()
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
  await h.started()
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

test('a start-up that rejects prints STARTUP FAILED and returns 1', async () => {
  const h = serviceHarness({ lgl: false })
  h.deps.startService = async ({ stdout }) => {
    stdout('STARTUP VG signed in as service-account-vg-sync')
    stdout('STARTUP LGL reached')
    throw new Error('the scheduler would not start')
  }
  assert.equal(await run([], h.deps), 1)
  assert.equal(h.out.at(-1), 'STARTUP FAILED the scheduler would not start')
})

test('a signal while the policy is read stops at once, without starting', async () => {
  const h = serviceHarness({ lgl: false })
  let release
  const read = h.deps.readFile
  h.deps.readFile = (p) => new Promise((resolve) => { release = () => resolve(read(p)) })
  let startCalled = false
  h.deps.startService = async () => { startCalled = true; return null }
  const done = run([], h.deps)
  await h.ready
  h.handlers.SIGTERM()
  release()
  assert.equal(await done, 0)
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
  assert.equal(startCalled, false)
  assert.deepEqual(h.out, ['STOPPING', 'STOPPED'])
  assert.deepEqual(h.calls, [])
})

test('a signal during start-up stops at once: STOPPING, STOPPED, exit 0', async () => {
  const h = serviceHarness({ lgl: false })
  const fetchImpl = h.deps.fetchImpl
  h.deps.fetchImpl = (url, init) => new URL(url).hostname === 'auth.example.org' ? new Promise(() => {}) : fetchImpl(url, init)
  const done = run([], h.deps)
  await h.ready
  h.handlers.SIGTERM()
  h.handlers.SIGINT()
  assert.equal(await done, 0)
  assert.deepEqual(h.out, ['STOPPING', 'STOPPED'])
})

const checkHarness = (o = {}) => harness({ files: { 'policy.json': policyText() }, ...o })

test('vg-check refuses with no cursor', async () => {
  const h = checkHarness({ lgl: false })
  assert.equal(await run(['--once', 'vg-check'], h.deps), 2)
  assert.deepEqual(h.out, ['No VG cursor: give --after <auditId>'])
  assert.equal(h.calls.some((c) => c.includes('littlegreenlight')), false)
})

test('vg-check takes --after, reads the touched constituent and its gifts, and prints CHECK OK', async () => {
  const h = checkHarness({ feed: { lastAuditId: 9, more: false, persons: [{ personId: '10', changes: [] }] } })
  assert.equal(await run(['--once', 'vg-check', '--after', '4'], h.deps), 0)
  assert.ok(h.calls.some((c) => c.includes('/api/sync/changes') && c.includes('after=4')))
  assert.ok(h.calls.some((c) => c.includes('/constituents/1.json')))
  assert.ok(h.calls.some((c) => c.includes('/constituents/1/gifts.json')))
  assert.ok(h.out.some((l) => /^CHECK OK vg-check dry-run people=\d+ /.test(l)))
  assert.ok(h.out.some((l) => l.startsWith('{')), 'the counts block is printed')
})

test('vg-check takes its cursor from the newest run row with a vgCursor', async () => {
  const runs = [
    { runId: 3, kind: 'vg-check', result: 'failed', vgCursor: null, lglCursor: null },
    { runId: 2, kind: 'full', result: 'ok', vgCursor: 7, lglCursor: '2026-11-11T00:00:00.000Z' },
  ]
  const h = checkHarness({ runs })
  assert.equal(await run(['--once', 'vg-check'], h.deps), 0)
  assert.ok(h.calls.some((c) => c.includes('/api/sync/changes') && c.includes('after=7')))
})

test('lgl-check refuses with no cursor', async () => {
  const h = checkHarness({ lgl: false })
  assert.equal(await run(['--once', 'lgl-check'], h.deps), 2)
  assert.deepEqual(h.out, ['No LGL cursor: give --since <ISO time>'])
  assert.equal(h.calls.some((c) => c.includes('littlegreenlight')), false)
})

test('lgl-check takes the cursor from the newest run row', async () => {
  const runs = [
    { runId: 3, kind: 'lgl-check', result: 'failed', vgCursor: null, lglCursor: null },
    { runId: 2, kind: 'full', result: 'ok', vgCursor: 7, lglCursor: '2026-11-11T09:00:00.000Z' },
  ]
  const h = checkHarness({ runs })
  assert.equal(await run(['--once', 'lgl-check'], h.deps), 0)
  assert.ok(h.calls.some((c) => c.includes('littlegreenlight') && decodeURIComponent(c).includes('updated_from=2026-11-11T08:58:00.000Z')))
})

test('lgl-check takes --since and builds its cache before the check', async () => {
  const h = checkHarness({ lglUpdated: [{ ...constituents[0], updated_at: '2026-11-11T09:30:00Z' }] })
  assert.equal(await run(['--once', 'lgl-check', '--since', '2026-11-11T09:00:00Z'], h.deps), 0)
  const firstCheck = h.calls.findIndex((c) => decodeURIComponent(c).includes('updated_from'))
  const pull = h.calls.findIndex((c) => c.includes('/constituents/search') && !decodeURIComponent(c).includes('updated_from'))
  assert.ok(pull >= 0 && pull < firstCheck)
  assert.ok(h.calls.some((c) => c.includes('/gifts/search') && !decodeURIComponent(c).includes('updated_from')))
})

// A VG person whose first name agrees with the memory while LGL has moved on: a planned write to VG.
function plannedWrite() {
  const old = { ...constituents[0], first_name: 'Janet' }
  const memory = FIELDS.map((field) => ({
    personId: '10', field, lglConstituentId: '1', value: lglFields(old).values[field], lglEntryId: null, agreedAt: '2026-11-01T00:00:00Z',
  }))
  const person = { ...persons[0], detail: { ...persons[0].detail, firstName: 'Janet' } }
  return { memory, personsBody: [person], acceptWrites: true, feed: { lastAuditId: 9, more: false, persons: [{ personId: '10', changes: [] }] } }
}
const isVgWrite = (r) => r.startsWith('PATCH ') || r.startsWith('PUT ') || (r.startsWith('POST ') && r.includes('/api/sync/'))

test('a check by hand is dry without --write-vg and writes with it', async () => {
  const dry = checkHarness(plannedWrite())
  assert.equal(await run(['--once', 'vg-check', '--after', '4'], dry.deps), 0)
  assert.match(dry.out.at(-1), /^CHECK OK vg-check dry-run people=1 writes=1 /)
  assert.deepEqual(dry.requests.filter(isVgWrite), [])
  assert.equal(dry.requests.some((r) => r.startsWith('POST /api/sync/runs')), false)

  const wet = checkHarness(plannedWrite())
  assert.equal(await run(['--once', 'vg-check', '--write-vg', '--after', '4'], wet.deps), 0)
  assert.match(wet.out.at(-1), /^CHECK OK vg-check write-vg people=1 writes=1 /)
  assert.ok(wet.requests.some((r) => r.startsWith('PATCH /api/persons/10')), wet.requests.join('\n'))
  assert.ok(wet.requests.includes('POST /api/sync/runs'))
})

test('lgl-check by hand touches a constituent its own pull already holds, when it is in the window', async () => {
  // The pull before the check reads the edit already: a constituent changed since two minutes
  // before the cursor is still touched, as the service's cache (from an earlier pass) would have it.
  const edited = { ...constituents[0], updated_at: '2026-11-11T09:30:00Z' }
  const older = { ...constituents[0], id: 2, updated_at: '2026-11-11T08:00:00Z' }
  const h = checkHarness({ ...plannedWrite(), lglPull: [edited, older], lglUpdated: [edited] })
  assert.equal(await run(['--once', 'lgl-check', '--since', '2026-11-11T09:00:00Z'], h.deps), 0)
  assert.match(h.out.at(-1), /^CHECK OK lgl-check dry-run people=1 writes=1 /)
})

test('lgl-check by hand counts a gift in its window as new, though its own pull holds it', async () => {
  // The constituent is outside the window (a gift does not move its updated_at); the gift search
  // starts the day before the cursor's date, and the gift was updated after that.
  const c = { ...constituents[0], updated_at: '2026-11-01T08:00:00Z' }
  const old = { ...gifts[0], updated_at: '2025-06-02T12:00:00Z' }
  const fresh = { id: 2, constituent_id: 1, received_date: '2026-11-10', gift_type_id: 1, fund_id: 9, payment_type_id: 1, updated_at: '2026-11-11T09:30:00Z' }
  const h = checkHarness({ lglPull: [c], lglGiftsPull: [old, fresh], lglGiftsUpdated: [fresh] })
  assert.equal(await run(['--once', 'lgl-check', '--since', '2026-11-11T09:00:00Z'], h.deps), 0)
  assert.ok(h.calls.some((c) => c.includes('/gifts/search') && decodeURIComponent(c).includes('updated_from=2026-11-10')))
  assert.match(h.out.at(-1), /^CHECK OK lgl-check dry-run people=1 /)
})

test('a check by hand that finds nothing says so', async () => {
  const h = checkHarness()
  assert.equal(await run(['--once', 'vg-check', '--after', '4'], h.deps), 0)
  assert.deepEqual(h.out, ['CHECK OK vg-check dry-run no changes'])
})

test('a bad or missing check cursor exits 2 without any request', async () => {
  const cases = [
    [['--once', 'vg-check', '--after', 'abc'], /--after must be a whole number/],
    [['--once', 'vg-check', '--after'], /--after needs a value/],
    [['--once', 'lgl-check', '--since', 'not-a-date'], /--since must be an ISO time/],
    [['--once', 'lgl-check', '--since'], /--since needs a value/],
  ]
  for (const [argv, re] of cases) {
    const h = checkHarness({ lgl: false })
    assert.equal(await run(argv, h.deps), 2, argv.join(' '))
    assert.match(h.out.join('\n'), re)
    assert.deepEqual(h.calls, [])
  }
})

test('vg-check reads every touched constituent, past 20', async () => {
  const n = 25
  const people = Array.from({ length: n }, (_, k) => ({
    ...persons[0], personId: 100 + k, donor: { lglConstituentId: String(500 + k), lastGiftDate: '2025-06-01' },
  }))
  const h = checkHarness({ personsBody: people, feed: { lastAuditId: 9, more: false, persons: people.map((p) => ({ personId: String(p.personId), changes: [] })) } })
  assert.equal(await run(['--once', 'vg-check', '--after', '4'], h.deps), 0)
  for (let k = 0; k < n; k++) assert.ok(h.calls.some((c) => c.includes(`/constituents/${500 + k}.json`)), `constituent ${500 + k}`)
})

test('a check failure prints CHECK FAILED and exits 1', async () => {
  const h = checkHarness({ personsStatus: 500, personsBody: { error: 'boom' }, feed: { lastAuditId: 9, more: false, persons: [{ personId: '10', changes: [] }] } })
  assert.equal(await run(['--once', 'vg-check', '--after', '4'], h.deps), 1)
  assert.match(h.out.at(-1), /^CHECK FAILED vg-check /)
})

test('--snapshot and --max-people are refused by the checks', async () => {
  for (const kind of ['vg-check', 'lgl-check']) {
    for (const opt of [['--snapshot', 'x.json'], ['--max-people', '3']]) {
      const h = checkHarness({ lgl: false })
      assert.equal(await run(['--once', kind, ...opt], h.deps), 2)
      assert.match(h.out.join('\n'), /^Unknown option /)
    }
  }
})
