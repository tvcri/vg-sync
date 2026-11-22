import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startService, pruneRecords } from '../../src/vg-mailchimp/service.js'

const START = Date.parse('2026-11-21T10:00:00.000Z')
const DAY = 86_400_000
const config = {
  runUtc: '08:00', runTimeoutMinutes: 30, recordsKeepDays: 30, outDir: 'out', minCohort: 500,
  writeAdd: true, writeArchive: false, maxAdd: 50, maxArchive: 50,
  mailchimp: { listName: 'Test Audience', mock: null },
}
const flush = () => new Promise((resolve) => setImmediate(resolve))

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

function setup({ whoAmI, getList, listPersons = hang, cfg = config, fs } = {}) {
  const c = clock()
  const out = []
  const sleeps = []
  const calls = { whoAmI: 0, getList: 0 }
  const vg = {
    whoAmI: async (opts) => { calls.whoAmI++; calls.whoAmIOpts ??= opts; return whoAmI ? whoAmI(opts) : { username: 'vg-mailchimp' } },
    listPersons: () => listPersons(),
  }
  const mc = {
    getList: async () => { calls.getList++; return getList ? getList() : { id: 'l1', name: 'Test Audience', stats: {} } },
  }
  const deps = {
    config: cfg, vg, mc, stdout: (t) => out.push(t), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
    sleep: async (ms) => { sleeps.push(ms) }, writeFile: async () => {},
    fs: fs ?? { readdir: async () => [], stat: async () => ({ mtimeMs: START }), unlink: async () => {} },
  }
  return { c, out, sleeps, calls, deps }
}

test('startup prints the three markers in order', async () => {
  const s = setup()
  const svc = await startService(s.deps)
  assert.ok(svc)
  assert.deepEqual(s.out.slice(0, 3), [
    'STARTUP VG signed in as vg-mailchimp',
    'STARTUP Mailchimp audience Test Audience reached',
    'STARTUP scheduler started write-add=on write-archive=off nightly=08:00Z',
  ])
  await svc.stop()
})

test('audience name mismatch refuses, naming both names', async () => {
  const s = setup({ getList: () => ({ id: 'l', name: 'Other', stats: {} }) })
  assert.equal(await startService(s.deps), null)
  const last = s.out.at(-1)
  assert.match(last, /^STARTUP FAILED /)
  assert.ok(last.includes('Test Audience') && last.includes('Other'))
  assert.equal(s.c.pending(), 0)
})

test('a mock with an empty listName skips the name check', async () => {
  const s = setup({ cfg: { ...config, mailchimp: { listName: '', mock: 'state.json' } }, getList: () => ({ id: 'l', name: 'Mock List', stats: {} }) })
  const svc = await startService(s.deps)
  assert.ok(svc)
  assert.equal(s.out[1], 'STARTUP Mailchimp audience Mock List reached')
  await svc.stop()
})

test('an empty listName without a mock still refuses', async () => {
  const s = setup({ cfg: { ...config, mailchimp: { listName: '', mock: null } } })
  assert.equal(await startService(s.deps), null)
  assert.match(s.out.at(-1), /^STARTUP FAILED /)
})

test('startup fails after three tries', async () => {
  const s = setup({ whoAmI: () => { throw new TypeError('fetch failed') } })
  assert.equal(await startService(s.deps), null)
  assert.equal(s.calls.whoAmI, 3)
  assert.deepEqual(s.sleeps, [20000, 20000])
  assert.match(s.out.at(-1), /^STARTUP FAILED .*fetch failed/)
  assert.equal(s.calls.getList, 0)
})

test('startup does not retry a refused sign-in', async () => {
  const s = setup({ whoAmI: () => { throw Object.assign(new Error('VG sign-in refused (401)'), { final: true }) } })
  assert.equal(await startService(s.deps), null)
  assert.equal(s.calls.whoAmI, 1)
  assert.match(s.out.at(-1), /^STARTUP FAILED .*refused/)
})

test('startup retries Mailchimp and succeeds on the third try', async () => {
  let n = 0
  const s = setup({ getList: () => { if (++n < 3) throw new Error('503'); return { id: 'l', name: 'Test Audience', stats: {} } } })
  const svc = await startService(s.deps)
  assert.ok(svc)
  assert.equal(s.calls.getList, 3)
  await svc.stop()
})

test('startup asks VG with a 15-second timeout', async () => {
  const s = setup()
  const svc = await startService(s.deps)
  assert.deepEqual(s.calls.whoAmIOpts, { timeoutMs: 15_000 })
  await svc.stop()
})

test('stop() aborts the running job with shutdown and awaits it; nothing is scheduled after', async () => {
  const s = setup() // listPersons hangs: the run is in its first read
  const svc = await startService(s.deps)
  await s.c.advance(0)
  const stopped = svc.stop()
  await s.c.advance(0)
  await stopped
  assert.equal(s.c.pending(), 0)
  await s.c.advance(3 * DAY)
  assert.equal(s.calls.getList, 1)
})

test('the run ceiling aborts the job with timeout and the run reports MAILCHIMP FAILED', async () => {
  const s = setup()
  const svc = await startService(s.deps)
  await s.c.advance(31 * 60_000)
  assert.ok(s.out.some((l) => l.startsWith('MAILCHIMP FAILED')), s.out.join('\n'))
  await svc.stop()
})

test('a cohort below MIN_COHORT fails and is not retried', async () => {
  const s = setup({ listPersons: async () => [] })
  const svc = await startService(s.deps)
  await s.c.advance(2 * 3_600_000)
  assert.equal(s.out.filter((l) => l.startsWith('MAILCHIMP FAILED')).length, 1)
  await svc.stop()
})

test('a prune failure prints a line and does not fail the job', async () => {
  const fs = { readdir: async () => { throw new Error('disk gone') }, stat: async () => ({}), unlink: async () => {} }
  const s = setup({ listPersons: async () => [], fs })
  const svc = await startService(s.deps)
  await s.c.advance(2 * 3_600_000)
  assert.ok(s.out.some((l) => l.includes('Old records files were not deleted: disk gone')))
  await svc.stop()
})

test('pruneRecords deletes only matching old files', async () => {
  const now = () => START
  const mtimes = {
    'mailchimp-old.jsonl': START - 40 * DAY, 'mailchimp-new.jsonl': START - 5 * DAY,
    'audience-old.json': START - 40 * DAY, 'audience-new.json': START - DAY,
    'other-old.jsonl': START - 40 * DAY, 'notes.txt': START - 40 * DAY,
  }
  const deleted = []
  const n = await pruneRecords({
    dir: 'out', keepDays: 30, now,
    readdir: async () => Object.keys(mtimes),
    stat: async (p) => ({ mtimeMs: mtimes[p.replace('out/', '')] }),
    unlink: async (p) => { deleted.push(p) },
  })
  assert.equal(n, 2)
  assert.deepEqual(deleted.sort(), ['out/audience-old.json', 'out/mailchimp-old.jsonl'])
})

test('pruneRecords: a missing directory is zero', async () => {
  const n = await pruneRecords({ dir: 'x', keepDays: 1, now: () => START, readdir: async () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }) }, stat: async () => ({}), unlink: async () => {} })
  assert.equal(n, 0)
})
