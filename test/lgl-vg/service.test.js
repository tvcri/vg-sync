import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { startService, pruneDecisions } from '../../src/lgl-vg/service.js'
import { parsePolicy } from '../../src/lgl-vg/policy.js'

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
    getChanges: async () => ({ lastAuditId: null, more: false, persons: [] }),
  }
  const lgl = {
    probe: async (opts) => { calls.probe++; calls.firstProbeOpts ??= opts; if (probe) return probe(opts); return { rateLimited: false } },
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

test('startup asks VG and LGL each with a 15-second timeout for the whole call', async () => {
  const s = setup()
  const svc = await startService(s.deps)
  assert.deepEqual(s.calls.firstWhoAmIOpts, { timeoutMs: 15_000 })
  assert.deepEqual(s.calls.firstProbeOpts, { timeoutMs: 15_000 })
  await svc.stop()
})

test('startup takes an LGL 429 as reached, at once', async () => {
  const s = setup({ probe: () => ({ rateLimited: true }) })
  const svc = await startService(s.deps)
  assert.ok(svc)
  assert.equal(s.calls.probe, 1)
  assert.deepEqual(s.sleeps, [])
  assert.equal(s.out[1], 'STARTUP LGL reached (rate-limited)')
  assert.ok(s.out[1].startsWith('STARTUP LGL reached'))
  await svc.stop()
})

test('startup does not retry a VG 403 and says what to check', async () => {
  const forbidden = Object.assign(
    new Error('VG GET /user → 403: forbidden (check that the service account has a role grant, a privacy acknowledgement, and the scope in VG_SCOPE)'),
    { status: 403 },
  )
  const s = setup({ whoAmI: () => { throw forbidden } })
  assert.equal(await startService(s.deps), null)
  assert.equal(s.calls.whoAmI, 1)
  assert.deepEqual(s.sleeps, [])
  assert.match(s.out.at(-1), /^STARTUP FAILED VG sign-in failed: .*403.*role grant/)
})

// Under fake time: a slow check runs to its timeout, sleep advances the clock, and every attempt and sleep
// is recorded with its start time. The whole start-up shares one 80-second budget.
function timed({ vgFailures, lglFailures }) {
  let t = START
  const log = []
  let vgN = 0
  let lglN = 0
  const s = setup({
    whoAmI: (opts) => {
      log.push({ at: t, what: 'vg', timeoutMs: opts.timeoutMs })
      if (++vgN <= vgFailures) { t += opts.timeoutMs; throw new Error('VG GET /user timed out') }
      return { username: 'vg-sync' }
    },
    probe: (opts) => {
      log.push({ at: t, what: 'lgl', timeoutMs: opts.timeoutMs })
      if (++lglN <= lglFailures) { t += opts.timeoutMs; throw new Error('LGL GET /constituents.json timed out') }
      return { rateLimited: false }
    },
  })
  const deps = { ...s.deps, now: () => t, sleep: async (ms) => { log.push({ at: t, what: 'sleep', ms }); t += ms } }
  return { s, deps, log, elapsed: () => t - START }
}

test('start-up checks share one budget: VG slow twice then fine, LGL failing, all inside the health gate', async () => {
  const x = timed({ vgFailures: 2, lglFailures: Infinity })
  assert.equal(await startService(x.deps), null)
  assert.equal(x.s.out[0], 'STARTUP VG signed in as vg-sync')
  assert.match(x.s.out.at(-1), /^STARTUP FAILED LGL not reached: /)
  assert.ok(x.elapsed() <= 80_000, `${x.elapsed()} ms`)
  for (const e of x.log) assert.ok(e.at < START + 80_000, JSON.stringify(e))
  for (const e of x.log.filter((e) => e.what !== 'sleep')) assert.ok(e.timeoutMs <= 15_000 && e.timeoutMs <= START + 80_000 - e.at)
  // VG used 70 s; LGL got the 10 s left for one try, and no sleep that would end past the budget
  assert.deepEqual(x.log.filter((e) => e.what === 'lgl').map((e) => e.timeoutMs), [10_000])
})

test('the worst start-up failure of either check alone, or both, ends inside the health gate', async () => {
  for (const [vgFailures, lglFailures] of [[Infinity, 0], [0, Infinity], [2, Infinity], [1, Infinity], [2, 2]]) {
    const x = timed({ vgFailures, lglFailures })
    const svc = await startService(x.deps)
    assert.ok(x.elapsed() <= 80_000, `${vgFailures}/${lglFailures}: ${x.elapsed()} ms`)
    for (const e of x.log) assert.ok(e.at < START + 80_000, `${vgFailures}/${lglFailures}: ${JSON.stringify(e)}`)
    if (svc) await svc.stop()
    else assert.match(x.s.out.at(-1), /^STARTUP FAILED (VG sign-in failed|LGL not reached): /)
  }
})

test('when the budget runs out the failure names the check and its last error', async () => {
  const x = timed({ vgFailures: 2, lglFailures: Infinity })
  await startService(x.deps)
  assert.match(x.s.out.at(-1), /^STARTUP FAILED LGL not reached: start-up time ran out \(80 s\); last error: LGL GET \/constituents\.json timed out$/)
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
  assert.match(s.out.at(-1), /^SYNC ALIVE last-full=\S+ result=failed next-full=2026-11-12T11:30:00\.000Z last-vg-check=none last-lgl-check=none lgl-every=5m$/)
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

test('pruneDecisions deletes old checks files', async () => {
  const ages = { 'checks-a.jsonl': 31, 'checks-b.jsonl': 29, 'full-c.jsonl': 40 }
  const deleted = []
  const n = await pruneDecisions({
    dir: 'out', keepDays: 30, now: () => START,
    readdir: async () => Object.keys(ages),
    stat: async (p) => ({ mtimeMs: START - ages[p.split('/').pop()] * DAY }),
    unlink: async (p) => { deleted.push(p) },
  })
  assert.equal(n, 2)
  assert.deepEqual(deleted, ['out/checks-a.jsonl', 'out/full-c.jsonl'])
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
