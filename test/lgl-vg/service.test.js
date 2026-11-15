import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { startService, pruneDecisions } from '../../src/lgl-vg/service.js'
import { parsePolicy } from '../../src/lgl-vg/policy.js'
import { PROBE_TIMEOUT_MS } from '../../src/lgl-vg/lgl.js'

const policy = parsePolicy(readFileSync(new URL('../../policy.json', import.meta.url), 'utf8'))
const START = Date.parse('2026-11-12T10:00:00.000Z')
const DAY = 86_400_000
const config = {
  lgl: { membershipFundId: 5, paypalPaymentTypeId: 2 },
  circuitBreakerPeople: 50, maxConstituentDropPercent: 10, imageRevision: 'abc123',
  writeVg: true, fullPassUtc: '07:00', outDir: 'out', decisionsKeepDays: 30, passTimeoutMinutes: 30,
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

// A fake clock: timers fire only when advance() passes their due time.
function clock(start = START) {
  let t = start
  let id = 0
  const timers = new Map()
  return {
    now: () => t,
    setTimer: (fn, ms) => { timers.set(++id, { at: t + ms, fn }); return id },
    clearTimer: (i) => { timers.delete(i) },
    pending: () => timers.size,
    async advance(ms) {
      const end = t + ms
      for (;;) {
        const next = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        timers.delete(next[0])
        t = next[1].at
        next[1].fn()
        await flush()
      }
      t = end
      await flush()
    },
  }
}

const hang = () => new Promise(() => {})

function setup({ whoAmI, probe, pullConstituents = hang } = {}) {
  const c = clock()
  const out = []
  const sleeps = []
  const calls = { whoAmI: 0, probe: 0 }
  const vg = {
    whoAmI: async (opts) => { calls.whoAmI++; calls.firstWhoAmIOpts ??= opts; return whoAmI ? whoAmI(opts) : { username: 'vg-sync', userId: 1 } },
    listPersons: async () => [],
    getSyncFields: async () => [],
    getSyncHolds: async () => [],
    lastFullRun: async () => null,
    recentRuns: async () => [],
  }
  const lgl = {
    probe: async () => { calls.probe++; if (probe) return probe() },
    pullConstituents: () => pullConstituents(),
    pullGifts: async () => [],
  }
  const files = []
  const fs = { readdir: async () => [], stat: async () => ({ mtimeMs: START }), unlink: async () => {} }
  const deps = {
    config, policy, vg, lgl, stdout: (t) => out.push(t), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
    sleep: async (ms) => { sleeps.push(ms) }, writeLines: async (p, text) => files.push({ path: p, text }), fs,
  }
  return { c, out, sleeps, calls, deps, files }
}

test('startup prints the three markers in order', async () => {
  const s = setup()
  const svc = await startService(s.deps)
  assert.ok(svc)
  assert.deepEqual(s.out.slice(0, 3), [
    'STARTUP VG signed in as vg-sync',
    'STARTUP LGL reached',
    'STARTUP scheduler started write-vg=on nightly=07:00Z',
  ])
  await svc.stop()
})

test('startup says write-vg=off for a dry-run service', async () => {
  const s = setup()
  const svc = await startService({ ...s.deps, config: { ...config, writeVg: false, fullPassUtc: '06:30' } })
  assert.equal(s.out[2], 'STARTUP scheduler started write-vg=off nightly=06:30Z')
  await svc.stop()
})

test('startup fails after three tries', async () => {
  const s = setup({ whoAmI: () => { throw new TypeError('fetch failed') } })
  assert.equal(await startService(s.deps), null)
  assert.equal(s.calls.whoAmI, 3)
  assert.deepEqual(s.sleeps, [20000, 20000])
  assert.match(s.out.at(-1), /^STARTUP FAILED .*fetch failed/)
  assert.equal(s.calls.probe, 0)
  assert.equal(s.c.pending(), 0, 'no scheduler was started')
})

test('startup does not retry a refused sign-in', async () => {
  const s = setup({ whoAmI: () => { throw Object.assign(new Error('VG sign-in refused (401)'), { final: true }) } })
  assert.equal(await startService(s.deps), null)
  assert.equal(s.calls.whoAmI, 1)
  assert.deepEqual(s.sleeps, [])
  assert.match(s.out.at(-1), /^STARTUP FAILED .*refused/)
})

test('startup retries LGL and succeeds on the third try', async () => {
  let n = 0
  const s = setup({ probe: () => { if (++n < 3) throw new Error('LGL GET /constituents.json → 503: busy') } })
  const svc = await startService(s.deps)
  assert.ok(svc)
  assert.equal(s.calls.probe, 3)
  assert.deepEqual(s.sleeps, [20000, 20000])
  assert.equal(s.out[1], 'STARTUP LGL reached')
  await svc.stop()
})

test('startup asks VG with a 15-second timeout for the whole call', async () => {
  const s = setup()
  const svc = await startService(s.deps)
  assert.deepEqual(s.calls.firstWhoAmIOpts, { timeoutMs: 15_000 })
  await svc.stop()
})

// Under fake time: every check runs to its timeout (VG's default is 60 s), and sleep advances the clock.
test('the worst start-up failure ends within the deployer\'s 90-second health gate', async () => {
  for (const failing of ['vg', 'lgl']) {
    let t = 0
    const s = setup({
      whoAmI: (opts) => { if (failing === 'vg') { t += opts?.timeoutMs ?? 60_000; throw new Error('timed out') } return { username: 'vg-sync' } },
      probe: () => { t += PROBE_TIMEOUT_MS; throw new Error('timed out') },
    })
    assert.equal(await startService({ ...s.deps, sleep: async (ms) => { t += ms } }), null)
    assert.match(s.out.at(-1), /^STARTUP FAILED /)
    assert.ok(t <= 90_000, `${failing}: ${t} ms`)
  }
})

test('a pass past its ceiling is aborted with timeout', async () => {
  const s = setup()
  const svc = await startService(s.deps)
  await flush()
  await s.c.advance(29 * 60 * 1000)
  assert.equal(s.out.some((l) => l.startsWith('PASS')), false)
  await s.c.advance(60 * 1000)
  assert.ok(s.out.includes('PASS FAILED full timed out after 30 minutes'), s.out.join('\n'))
  // the scheduler took it as a retryable failure: the heartbeat says failed, with a retry due in an hour
  await s.c.advance(5 * 60 * 1000)
  assert.match(s.out.at(-1), /^SYNC ALIVE last-full=\S+ result=failed next-full=2026-11-12T11:30:00\.000Z$/)
  await svc.stop()
})

test('stop aborts the running pass with shutdown', async () => {
  const s = setup()
  const svc = await startService(s.deps)
  await flush()
  await svc.stop()
  assert.equal(s.out.at(-1), 'PASS STOPPED full stopped by shutdown')
  assert.equal(s.c.pending(), 0, 'no timer is left armed')
})

test('a finished pass writes its decisions to OUT_DIR, prints only its PASS line, and prunes', async () => {
  const s = setup({ pullConstituents: async () => [] })
  let pruned = 0
  s.deps.fs.readdir = async (dir) => { pruned++; assert.equal(dir, 'out'); return [] }
  const svc = await startService({ ...s.deps, config: { ...config, writeVg: false } })
  for (let i = 0; i < 5; i++) await flush()
  const after = s.out.slice(3)
  assert.equal(after.length, 2, after.join('\n')) // the skipped drop check, then the PASS line; no JSON block
  assert.match(after[1], /^PASS OK full dry-run /)
  assert.match(s.files[0].path, /^out\/full-.*\.jsonl$/)
  assert.equal(pruned, 1)
  await svc.stop()
})

test('pruneDecisions deletes only old full-*.jsonl files', async () => {
  const now = () => START
  const ages = { 'full-a.jsonl': 31, 'full-b.jsonl': 29, 'report-c.jsonl': 40 }
  const deleted = []
  const n = await pruneDecisions({
    dir: 'out', keepDays: 30, now,
    readdir: async () => Object.keys(ages),
    stat: async (p) => ({ mtimeMs: START - ages[p.split('/').pop()] * DAY }),
    unlink: async (p) => { deleted.push(p) },
  })
  assert.equal(n, 1)
  assert.deepEqual(deleted, ['out/full-a.jsonl'])
})

test('pruneDecisions treats a missing directory as nothing to delete', async () => {
  const n = await pruneDecisions({
    dir: 'nowhere', keepDays: 30, now: () => START,
    readdir: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
    stat: async () => { throw new Error('not called') },
    unlink: async () => { throw new Error('not called') },
  })
  assert.equal(n, 0)
})
