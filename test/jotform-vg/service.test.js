import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startService, describeError } from '../../src/jotform-vg/service.js'

const START = Date.parse('2026-11-21T10:00:00.000Z')
const MIN = 60_000
const config = { fullRunUtc: '08:00', changeEveryMinutes: 5, runTimeoutMinutes: 30, writeVg: true }
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
const okCounts = (kind, failed = 0) => ({ kind, failed })

function setup({ whoAmI, ping, runPass, cfg = config } = {}) {
  const c = clock()
  const out = []
  const sleeps = []
  const calls = { whoAmI: 0, ping: 0, passes: [], fatal: [] }
  const vg = {
    whoAmI: async (opts) => { calls.whoAmI++; calls.whoAmIOpts ??= opts; return whoAmI ? whoAmI(opts) : { username: 'vg-jotform' } },
    listPersons: () => hang(),
  }
  const jotform = { ping: async () => { calls.ping++; return ping ? ping() : { status: 'ENABLED' } } }
  const deps = {
    vg, jotform, stdout: (t) => out.push(t), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
    sleep: async (ms) => { sleeps.push(ms) }, onFatal: (e) => calls.fatal.push(e),
    runPass: runPass ?? (async (kind, { stdout }) => { calls.passes.push(kind); stdout(`JOTFORM OK ${kind}`); return okCounts(kind) }),
  }
  return { c, out, sleeps, calls, deps, cfg }
}
const start = (s) => startService({ config: s.cfg, deps: s.deps })

test('startup prints its markers in order and runs a full pass first', async () => {
  const s = setup()
  const svc = await start(s)
  assert.ok(svc)
  await s.c.advance(0)
  assert.deepEqual(s.out.slice(0, 4), [
    'STARTUP VG signed in as vg-jotform',
    'STARTUP JotForm form reached',
    'STARTUP scheduler started write-vg=on full=08:00Z change-every=5m',
    'JOTFORM OK full',
  ])
  await s.c.advance(5 * MIN)
  assert.deepEqual(s.calls.passes, ['full', 'change'])
  await svc.stop()
})

test('a form that is not ENABLED is a warning, not a failure', async () => {
  const s = setup({ ping: () => ({ status: 'DISABLED' }) })
  const svc = await start(s)
  assert.ok(svc)
  assert.equal(s.out[1], 'JOTFORM WARN form status is DISABLED, not ENABLED')
  await svc.stop()
})

test('startup fails after three tries and prints no body', async () => {
  const s = setup({ whoAmI: () => { throw new Error('VG GET /user → 500: {"name":"Jane Doe"}') } })
  assert.equal(await start(s), null)
  assert.equal(s.calls.whoAmI, 3)
  assert.deepEqual(s.sleeps, [20000, 20000])
  assert.equal(s.out.at(-1), 'STARTUP FAILED VG sign-in failed: VG GET /user → 500')
  assert.equal(s.calls.ping, 0)
})

test('startup does not retry a refused sign-in or a 403', async () => {
  const s = setup({ whoAmI: () => { throw Object.assign(new Error('VG sign-in refused'), { final: true }) } })
  assert.equal(await start(s), null)
  assert.equal(s.calls.whoAmI, 1)
  const s2 = setup({ ping: () => { throw Object.assign(new Error('JotForm GET /form/123456 → 403: nope'), { status: 403, final: true }) } })
  assert.equal(await start(s2), null)
  assert.equal(s2.calls.ping, 1)
  assert.equal(s2.out.at(-1), 'STARTUP FAILED JotForm not reached: JotForm GET /form/:id → 403')
})

test('startup retries JotForm and succeeds on the third try', async () => {
  let n = 0
  const s = setup({ ping: () => { if (++n < 3) throw new Error('503'); return { status: 'ENABLED' } } })
  const svc = await start(s)
  assert.ok(svc)
  assert.equal(s.calls.ping, 3)
  await svc.stop()
})

test('startup asks VG with a 15-second timeout', async () => {
  const s = setup()
  const svc = await start(s)
  assert.deepEqual(s.calls.whoAmIOpts, { timeoutMs: 15_000 })
  await svc.stop()
})

test('failed > 0 prints a WARN line after the OK line and the pass counts as succeeded', async () => {
  const s = setup({ runPass: async (kind, { stdout }) => { stdout(`JOTFORM OK ${kind}`); return okCounts(kind, 2) } })
  const svc = await start(s)
  await s.c.advance(0)
  assert.deepEqual(s.out.slice(3, 5), ['JOTFORM OK full', 'JOTFORM WARN full failed=2'])
  await s.c.advance(5 * MIN) // changes armed: the full pass succeeded
  assert.equal(s.out.filter((l) => l === 'JOTFORM OK change').length, 1)
  await svc.stop()
})

test('a failed pass prints a sanitized line; the body, name and id never reach stdout', async () => {
  const id = '5000000000000000001'
  const s = setup({
    runPass: async () => { throw new Error(`VG PUT /friends/sync/submissions/${id} → 500: {"detail":"Jane Doe, ${id}"}`) },
  })
  const svc = await start(s)
  await s.c.advance(0)
  assert.ok(s.out.includes('JOTFORM FAILED full: VG PUT /friends/sync/submissions/:id → 500'), s.out.join('\n'))
  const all = s.out.join('\n')
  assert.ok(!all.includes('Jane') && !all.includes(id))
  await svc.stop()
})

test('a guard error is printed as it is', async () => {
  const msg = 'full read returned 3 of 10 stored; nothing deleted'
  const s = setup({ runPass: async () => { throw new Error(msg) } })
  const svc = await start(s)
  await s.c.advance(0)
  assert.ok(s.out.includes(`JOTFORM FAILED full: ${msg}`))
  await svc.stop()
})

test('a failed full pass retries hourly', async () => {
  const s = setup({ runPass: async (kind) => { s.calls.passes.push(kind); throw new TypeError('fetch failed') } })
  const svc = await start(s)
  await s.c.advance(0)
  await s.c.advance(61 * MIN)
  assert.equal(s.calls.passes.length, 2)
  assert.ok(s.out.includes('JOTFORM FAILED full: network error: fetch failed'))
  await svc.stop()
})

test('a 401/403 or final error ends the service: onFatal is called and nothing more runs', async () => {
  for (const e of [{ status: 403 }, { status: 401 }, { final: true }]) {
    const s = setup({ runPass: async (kind) => { s.calls.passes.push(kind); throw Object.assign(new Error('JotForm GET /form/1234/submissions → 401: bad'), e) } })
    const svc = await start(s)
    await s.c.advance(3 * 3_600_000)
    assert.equal(s.calls.fatal.length, 1)
    assert.deepEqual(s.calls.passes, ['full'])
    await svc.stop()
  }
})

test('stop() aborts the running pass with shutdown and awaits it; nothing is scheduled after', async () => {
  const s = setup({ runPass: async (kind) => { s.calls.passes.push(kind); return hang() } })
  const svc = await start(s)
  await s.c.advance(0)
  await svc.stop()
  assert.equal(s.c.pending(), 0)
  await s.c.advance(3 * 86_400_000)
  assert.deepEqual(s.calls.passes, ['full'])
  assert.ok(!s.out.some((l) => l.startsWith('JOTFORM FAILED')))
})

test('the run ceiling abandons the pass and reports it failed', async () => {
  const s = setup({ runPass: async () => hang() })
  const svc = await start(s)
  await s.c.advance(31 * MIN)
  assert.ok(s.out.includes('JOTFORM FAILED full: run timed out after 30 minutes'), s.out.join('\n'))
  await svc.stop()
})

test('after the ceiling a pass still running fails at its next call to VG or JotForm', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  let result
  const s = setup({ runPass: async (kind, { vg }) => { await gate; result = await vg.listPersons().then(() => 'called', (e) => e.message) } })
  const svc = await start(s)
  await s.c.advance(31 * MIN)
  release()
  await flush()
  assert.equal(result, 'run timed out')
  await svc.stop()
})

test('describeError keeps the operation and status, drops the rest', () => {
  assert.equal(describeError(new Error('VG GET /persons?projection=detail → 500: body')), 'VG GET /persons → 500')
  assert.equal(describeError(new Error('JotForm GET /form/250001/submissions timed out after 60 s')), 'JotForm GET /form/:id/submissions timed out after 60 s')
  assert.equal(describeError(new Error('Keycloak token request → 401: {"x":"Jane Doe"}')), 'Keycloak token request → 401')
  assert.equal(describeError(Object.assign(new Error('Jane Doe odd'), { status: 502 })), 'HTTP 502')
  assert.equal(describeError(new Error('parse of Jane Doe failed')), 'unexpected Error')
})

test('describeError prints a TypeError only when it is fetch failed or has a known code', () => {
  assert.equal(describeError(new TypeError('fetch failed')), 'network error: fetch failed')
  assert.equal(describeError(Object.assign(new TypeError('x Jane Doe'), { cause: { code: 'ECONNREFUSED' } })), 'network error: ECONNREFUSED')
  assert.equal(describeError(new TypeError('Cannot read Jane Doe')), 'unexpected TypeError')
})

test('an abandoned pass prints nothing after its FAILED line', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const s = setup({ runPass: async (kind, { stdout }) => { await gate; stdout('JOTFORM OK full late') } })
  const svc = await start(s)
  await s.c.advance(31 * MIN)
  release()
  await flush()
  assert.ok(!s.out.includes('JOTFORM OK full late'))
  await svc.stop()
})
