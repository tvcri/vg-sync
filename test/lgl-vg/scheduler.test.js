import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextNightly, createScheduler } from '../../src/lgl-vg/scheduler.js'

const iso = (ms) => new Date(ms).toISOString()
const HOUR = 3_600_000

// Stops the scheduler while a pass may still be running: the fake clock has
// to move for that pass to return.
async function stopAll(clock, s) {
  const done = s.stop()
  await clock.advance(7 * 24 * HOUR)
  await done
}

// A fake clock and timer queue. advance(ms) fires due timers in time order
// (ties in the order they were set), letting microtasks settle between them.
function fakeClock(startIso) {
  let t = Date.parse(startIso)
  let nextId = 1
  const timers = new Map()
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
  }
  return {
    now: () => t,
    setTimer(fn, ms) {
      const id = nextId++
      timers.set(id, { at: t + ms, fn, id })
      return id
    },
    clearTimer(id) { timers.delete(id) },
    pending: () => timers.size,
    settle,
    async advance(ms) {
      const target = t + ms
      await settle()
      for (;;) {
        let due = null
        for (const tm of timers.values()) {
          if (tm.at <= target && (!due || tm.at < due.at || (tm.at === due.at && tm.id < due.id))) due = tm
        }
        if (!due) break
        timers.delete(due.id)
        t = due.at
        due.fn()
        await settle()
      }
      t = target
    },
  }
}

// opts may be a function of the clock, to wrap its timers.
function setup(startIso, runFullImpl, opts = {}) {
  const clock = fakeClock(startIso)
  if (typeof opts === 'function') opts = opts(clock)
  const lines = []
  const calls = []
  const runFull = () => {
    calls.push(iso(clock.now()))
    return runFullImpl(clock)
  }
  const s = createScheduler({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    fullPassUtc: '07:00', runFull, stdout: (l) => lines.push(l), ...opts,
  })
  return { clock, lines, calls, s }
}

const after = (clock, ms, result) => new Promise((r) => clock.setTimer(() => r(result), ms))
const ok = { outcome: 'ok', retryable: false }
const failedRetryable = { outcome: 'failed', retryable: true }
const failedFinal = { outcome: 'failed', retryable: false }

test('nextNightly: later the same day', () => {
  assert.equal(iso(nextNightly(Date.parse('2026-11-14T06:59:00Z'), '07:00')), '2026-11-14T07:00:00.000Z')
})

test('nextNightly: at the time itself, the next day', () => {
  assert.equal(iso(nextNightly(Date.parse('2026-11-14T07:00:00Z'), '07:00')), '2026-11-15T07:00:00.000Z')
})

test('nextNightly: across the year end', () => {
  assert.equal(iso(nextNightly(Date.parse('2026-12-31T23:00:00Z'), '00:30')), '2027-01-01T00:30:00.000Z')
})

test('start runs a full pass at once, then nightly', async () => {
  const { clock, calls, s } = setup('2026-11-14T12:00:00Z', async () => ok)
  s.start()
  await clock.advance(0)
  assert.deepEqual(calls, ['2026-11-14T12:00:00.000Z'])
  await clock.advance(2 * 24 * HOUR)
  assert.deepEqual(calls, ['2026-11-14T12:00:00.000Z', '2026-11-15T07:00:00.000Z', '2026-11-16T07:00:00.000Z'])
  await s.stop()
})

test('a due job waits for the running one and runs once', async () => {
  const { clock, calls, s } = setup('2026-11-14T06:00:00Z', (c) => after(c, 2 * HOUR, ok))
  s.start()
  await clock.advance(HOUR + 1) // the nightly comes due mid-pass
  assert.deepEqual(calls, ['2026-11-14T06:00:00.000Z'])
  await clock.advance(5 * HOUR)
  assert.deepEqual(calls, ['2026-11-14T06:00:00.000Z', '2026-11-14T08:00:00.000Z'])
  await s.stop()
})

test('a full pass due twice while one runs is queued once', async () => {
  // The first pass takes 30 hours, so the nightly comes due twice while it
  // runs; later passes are instant. Only one pass follows it.
  let first = true
  const { clock, calls, s } = setup('2026-11-14T06:00:00Z', (c) => {
    if (!first) return Promise.resolve(ok)
    first = false
    return after(c, 30 * HOUR, ok)
  })
  s.start()
  await clock.advance(48 * HOUR - 1)
  assert.deepEqual(calls, ['2026-11-14T06:00:00.000Z', '2026-11-15T12:00:00.000Z'])
  await s.stop()
})

test('a retryable failure retries hourly, three times, then waits for night', async () => {
  const { clock, calls, s } = setup('2026-11-14T08:00:00Z', async () => failedRetryable)
  s.start()
  await clock.advance(23 * HOUR + 30 * 60_000)
  assert.deepEqual(calls, [
    '2026-11-14T08:00:00.000Z', '2026-11-14T09:00:00.000Z', '2026-11-14T10:00:00.000Z',
    '2026-11-14T11:00:00.000Z', '2026-11-15T07:00:00.000Z',
  ])
  await s.stop()
})

test('an ok resets the retry count', async () => {
  // Two failures, then an ok: the next night's failure gets all three retries again.
  const results = [failedRetryable, failedRetryable, ok, failedRetryable, failedRetryable, failedRetryable, failedRetryable]
  const { clock, calls, s } = setup('2026-11-14T08:00:00Z', async () => results.shift() ?? ok)
  s.start()
  await clock.advance(27 * HOUR + 30 * 60_000)
  assert.deepEqual(calls, [
    '2026-11-14T08:00:00.000Z', '2026-11-14T09:00:00.000Z', '2026-11-14T10:00:00.000Z',
    '2026-11-15T07:00:00.000Z', '2026-11-15T08:00:00.000Z', '2026-11-15T09:00:00.000Z', '2026-11-15T10:00:00.000Z',
  ])
  await s.stop()
})

test('a final failure waits for night', async () => {
  const { clock, calls, lines, s } = setup('2026-11-14T08:00:00Z', async () => failedFinal)
  s.start()
  await clock.advance(5 * 60_000)
  assert.equal(lines.at(-1), 'SYNC ALIVE last-full=2026-11-14T08:00:00.000Z result=failed next-full=2026-11-15T07:00:00.000Z last-vg-check=none last-lgl-check=none lgl-every=5m')
  await clock.advance(23 * HOUR)
  assert.deepEqual(calls, ['2026-11-14T08:00:00.000Z', '2026-11-15T07:00:00.000Z'])
  await s.stop()
})

test('a rejected runFull counts as a retryable failure', async () => {
  const { clock, calls, lines, s } = setup('2026-11-14T08:00:00Z', async () => { throw new Error('boom') })
  s.start()
  await clock.advance(5 * 60_000)
  assert.deepEqual(lines, [
    'PASS FAILED full boom',
    'SYNC ALIVE last-full=2026-11-14T08:00:00.000Z result=failed next-full=2026-11-14T09:00:00.000Z last-vg-check=none last-lgl-check=none lgl-every=5m',
  ])
  await clock.advance(HOUR)
  assert.deepEqual(calls, ['2026-11-14T08:00:00.000Z', '2026-11-14T09:00:00.000Z'])
  await s.stop()
})

test('a throw inside the job prints PASS FAILED and the scheduler carries on', async () => {
  // Arming the retry timer throws: the job itself fails, not runFull.
  const { clock, calls, lines, s } = setup('2026-11-14T08:00:00Z', async () => failedRetryable, (clock) => ({
    setTimer: (fn, ms) => {
      if (ms === HOUR) throw new Error('timer broke')
      return clock.setTimer(fn, ms)
    },
  }))
  s.start()
  await clock.advance(5 * 60_000)
  assert.deepEqual(lines, [
    'PASS FAILED full scheduler error: timer broke',
    'SYNC ALIVE last-full=2026-11-14T08:00:00.000Z result=failed next-full=2026-11-15T07:00:00.000Z last-vg-check=none last-lgl-check=none lgl-every=5m',
  ])
  await clock.advance(23 * HOUR)
  assert.deepEqual(calls, ['2026-11-14T08:00:00.000Z', '2026-11-15T07:00:00.000Z'])
  await s.stop()
})

test('a nightly pass gets its own three retries', async () => {
  // Start-up pass at 05:30 fails, its retry at 06:30 fails, the nightly at
  // 07:00 (which replaces the 07:30 retry) fails: three retries follow it.
  const { clock, calls, s } = setup('2026-11-14T05:30:00Z', async () => failedRetryable)
  s.start()
  await clock.advance(6 * HOUR)
  assert.deepEqual(calls, [
    '2026-11-14T05:30:00.000Z', '2026-11-14T06:30:00.000Z', '2026-11-14T07:00:00.000Z',
    '2026-11-14T08:00:00.000Z', '2026-11-14T09:00:00.000Z', '2026-11-14T10:00:00.000Z',
  ])
  await s.stop()
})

test('start twice runs one pass', async () => {
  const { clock, calls, lines, s } = setup('2026-11-14T12:00:00Z', async () => ok)
  s.start()
  s.start()
  await clock.advance(5 * 60_000)
  assert.deepEqual(calls, ['2026-11-14T12:00:00.000Z'])
  assert.equal(lines.length, 1)
  await s.stop()
})

test('start after stop does nothing', async () => {
  const { clock, calls, s } = setup('2026-11-14T12:00:00Z', async () => ok)
  await s.stop()
  s.start()
  await clock.advance(2 * 24 * HOUR)
  assert.deepEqual(calls, [])
  assert.equal(clock.pending(), 0)
})

test('the heartbeat prints during a long pass', async () => {
  const { clock, lines, s } = setup('2026-11-14T06:00:00Z', (c) => after(c, 2 * HOUR, ok))
  s.start()
  await clock.advance(5 * 60_000)
  assert.deepEqual(lines, ['SYNC ALIVE last-full=none result=running next-full=2026-11-14T07:00:00.000Z last-vg-check=none last-lgl-check=none lgl-every=5m'])
  await clock.advance(2 * HOUR)
  assert.equal(lines.at(-1), 'SYNC ALIVE last-full=2026-11-14T08:00:00.000Z result=running next-full=2026-11-15T07:00:00.000Z last-vg-check=none last-lgl-check=none lgl-every=15m')
  await stopAll(clock, s)
})

test('the heartbeat before the first pass and after an ok', async () => {
  const { clock, lines, s } = setup('2026-11-14T12:00:00Z', async () => ok)
  s.start()
  await clock.advance(10 * 60_000)
  assert.deepEqual(lines, [
    'SYNC ALIVE last-full=2026-11-14T12:00:00.000Z result=ok next-full=2026-11-15T07:00:00.000Z last-vg-check=none last-lgl-check=none lgl-every=5m',
    'SYNC ALIVE last-full=2026-11-14T12:00:00.000Z result=ok next-full=2026-11-15T07:00:00.000Z last-vg-check=none last-lgl-check=none lgl-every=5m',
  ])
  await s.stop()
})

test('stop waits for the running pass and fires nothing after', async () => {
  const { clock, calls, lines, s } = setup('2026-11-14T06:00:00Z', (c) => after(c, 2 * HOUR, failedRetryable))
  s.start()
  await clock.advance(HOUR + 1) // nightly queued behind the running pass
  let stopped = false
  const done = s.stop().then(() => { stopped = true })
  await clock.settle()
  assert.equal(stopped, false)
  await clock.advance(HOUR) // the running pass returns
  await done
  assert.equal(stopped, true)
  const linesAtStop = lines.length
  assert.equal(clock.pending(), 0)
  await clock.advance(3 * 24 * HOUR)
  assert.deepEqual(calls, ['2026-11-14T06:00:00.000Z'])
  assert.equal(lines.length, linesAtStop)
})

test('stop when no pass is running resolves at once', async () => {
  const { clock, calls, s } = setup('2026-11-14T06:00:00Z', async () => ok)
  s.start()
  await clock.advance(0)
  await s.stop()
  assert.equal(clock.pending(), 0)
  await clock.advance(2 * 24 * HOUR)
  assert.equal(calls.length, 1)
})

test('a stopped outcome schedules nothing after it', async () => {
  const { clock, calls, lines, s } = setup('2026-11-14T06:00:00Z', (c) => after(c, 2 * HOUR, { outcome: 'stopped', retryable: false }))
  s.start()
  await clock.advance(3 * 24 * HOUR)
  assert.deepEqual(calls, ['2026-11-14T06:00:00.000Z'])
  assert.equal(lines.at(-1), 'SYNC ALIVE last-full=none result=none next-full=none last-vg-check=none last-lgl-check=none lgl-every=15m')
  await s.stop()
  assert.equal(clock.pending(), 0)
})

// --- Step 6: the tick ---

const MIN = 60_000
const at = (hms) => `2026-11-15T${hms}.000Z`
const checkOk = { outcome: 'ok', final: false, breaker: false, rateLimited: false, foundChange: false, error: null }
const checkResult = (over) => ({ ...checkOk, ...over })

// check(kind, opts, clock) gives each check's result; full(clock) each pass's.
function checkSetup(startIso, { full = async () => ok, check = async () => checkOk } = {}) {
  const checks = []
  const r = setup(startIso, full, (clock) => ({
    runCheck: (kind, opts) => {
      checks.push({ kind, at: iso(clock.now()), lglPaused: opts.lglPaused })
      return check(kind, opts, clock)
    },
  }))
  const times = (kind) => checks.filter((c) => c.kind === kind).map((c) => c.at)
  return { ...r, checks, times }
}

// ISO times from startIso, every stepMs, count of them.
const series = (startIso, stepMs, count) =>
  Array.from({ length: count }, (_, i) => iso(Date.parse(startIso) + i * stepMs))

test('no tick before the first successful full pass', async () => {
  // The start-up pass fails; its retry an hour later takes ten minutes and succeeds.
  const results = [failedRetryable]
  const { clock, checks, times, s } = checkSetup(at('12:00:00'), {
    full: (c) => (results.length ? Promise.resolve(results.shift()) : after(c, 10 * MIN, ok)),
  })
  s.start()
  await clock.advance(70 * MIN - 1) // just before the retry ends at 13:10
  assert.deepEqual(checks, [])
  await clock.advance(2 * MIN + 30_000)
  assert.deepEqual(times('vg-check'), [at('13:11:00'), at('13:12:00')])
  await s.stop()
})

test('ticks every 60 s after the previous tick ended', async () => {
  const { clock, times, s } = checkSetup(at('12:00:00'))
  s.start()
  await clock.advance(3 * MIN + 30_000)
  assert.deepEqual(times('vg-check'), [at('12:01:00'), at('12:02:00'), at('12:03:00')])
  await s.stop()
})

test('a slow tick does not stack', async () => {
  // Each VG check takes 90 s: the next tick is 60 s after it ended.
  const { clock, times, s } = checkSetup(at('12:00:00'), {
    check: (kind, opts, c) => (kind === 'vg-check' ? after(c, 90_000, checkOk) : Promise.resolve(checkOk)),
  })
  s.start()
  await clock.advance(8 * MIN)
  assert.deepEqual(times('vg-check'), [at('12:01:00'), at('12:03:30'), at('12:06:00')])
  await stopAll(clock, s)
})

test('the lgl check runs on every fifth tick, after the vg check', async () => {
  const { clock, checks, times, s } = checkSetup(at('12:00:00'))
  s.start()
  await clock.advance(11 * MIN)
  assert.deepEqual(times('lgl-check'), [at('12:05:00'), at('12:10:00')])
  assert.deepEqual(checks.filter((c) => c.at === at('12:05:00')).map((c) => c.kind), ['vg-check', 'lgl-check'])
  await s.stop()
})

test('after an idle hour, every fifteenth', async () => {
  const { clock, times, s } = checkSetup(at('12:00:00'))
  s.start()
  await clock.advance(90 * MIN)
  assert.deepEqual(times('lgl-check'), [
    ...series(at('12:05:00'), 5 * MIN, 11), // 12:05 .. 12:55
    at('13:10:00'), at('13:25:00'),
  ])
  await s.stop()
})

test('a change while at fifteen returns to five, at once if five ticks have passed', async () => {
  // At fifteen from 13:00; the last lgl check was 13:10. A change found by
  // the vg check six ticks later runs the lgl check on that same tick.
  {
    const { clock, times, s } = checkSetup(at('12:00:00'), {
      check: async (kind, opts, c) => checkResult({ foundChange: kind === 'vg-check' && iso(c.now()) === at('13:16:00') }),
    })
    s.start()
    await clock.advance(82 * MIN)
    assert.deepEqual(times('lgl-check').slice(-4), [at('12:55:00'), at('13:10:00'), at('13:16:00'), at('13:21:00')])
    await s.stop()
  }
  // A change two ticks after the 13:10 lgl check: it runs when the count reaches five.
  {
    const { clock, lines, times, s } = checkSetup(at('12:00:00'), {
      check: async (kind, opts, c) => checkResult({ foundChange: kind === 'vg-check' && iso(c.now()) === at('13:12:00') }),
    })
    s.start()
    await clock.advance(81 * MIN)
    assert.deepEqual(times('lgl-check').slice(-3), [at('13:10:00'), at('13:15:00'), at('13:20:00')])
    assert.match(lines.at(-1), /lgl-every=5m$/) // heartbeat at 13:20
    await s.stop()
  }
})

test('a tick due during a full pass waits and runs once', async () => {
  // Start at 06:55:30; the nightly pass at 07:00 takes ten minutes. The tick
  // due at 07:00:30 runs at 07:10, once, and the count goes up once: it is
  // the fifth tick, so the lgl check runs with it.
  let first = true
  const { clock, calls, times, s } = checkSetup(at('06:55:30'), {
    full: (c) => {
      if (first) { first = false; return Promise.resolve(ok) }
      return after(c, 10 * MIN, ok)
    },
  })
  s.start()
  await clock.advance(16 * MIN)
  assert.deepEqual(calls, [at('06:55:30'), at('07:00:00')])
  assert.deepEqual(times('vg-check'), [at('06:56:30'), at('06:57:30'), at('06:58:30'), at('06:59:30'), at('07:10:00'), at('07:11:00')])
  assert.deepEqual(times('lgl-check'), [at('07:10:00')])
  await s.stop()
})

test('a nightly pass due during a tick waits for it', async () => {
  // The vg check of the 06:59:30 tick takes two minutes.
  const { clock, calls, times, s } = checkSetup(at('06:55:30'), {
    check: (kind, opts, c) => (kind === 'vg-check' && iso(c.now()) === at('06:59:30')
      ? after(c, 2 * MIN, checkOk) : Promise.resolve(checkOk)),
  })
  s.start()
  await clock.advance(7 * MIN + 30_000)
  assert.deepEqual(calls, [at('06:55:30'), at('07:01:30')])
  assert.deepEqual(times('vg-check'), [at('06:56:30'), at('06:57:30'), at('06:58:30'), at('06:59:30'), at('07:02:30')])
  await s.stop()
})

test('a failed vg check is still followed by the lgl check due on that tick', async () => {
  const { clock, lines, times, s } = checkSetup(at('12:00:00'), {
    check: async (kind) => (kind === 'vg-check' ? checkResult({ outcome: 'failed', error: 'VG down' }) : checkOk),
  })
  s.start()
  await clock.advance(5 * MIN)
  assert.deepEqual(times('lgl-check'), [at('12:05:00')])
  assert.deepEqual(lines.filter((l) => l.startsWith('CHECK')), Array(5).fill('CHECK FAILED vg-check VG down'))
  await s.stop()
})

test('CHECK FAILED until 15 minutes, then PASS FAILED once, again after 60 minutes, then CHECK RECOVERED', async () => {
  // The vg check fails from 12:01 to 13:19 and succeeds from 13:20.
  const recoverAt = Date.parse(at('13:20:00'))
  const { clock, lines, s } = checkSetup(at('12:00:00'), {
    check: async (kind, opts, c) => (kind === 'vg-check' && c.now() < recoverAt
      ? checkResult({ outcome: 'failed', error: 'VG down' }) : checkOk),
  })
  s.start()
  await clock.advance(82 * MIN)
  const expected = []
  for (let i = 1; i < 80; i++) {
    expected.push('CHECK FAILED vg-check VG down')
    if (i === 16 || i === 76) expected.push('PASS FAILED vg-check failing since 2026-11-15T12:01:00.000Z: VG down')
  }
  expected.push('CHECK RECOVERED vg-check')
  assert.deepEqual(lines.filter((l) => !l.startsWith('SYNC ALIVE')), expected)
  await s.stop()
})

test('a final error halts checks until a full pass succeeds', async () => {
  const { clock, lines, times, s } = checkSetup(at('06:55:30'), {
    check: async (kind, opts, c) => (kind === 'vg-check' && iso(c.now()) === at('06:57:30')
      ? checkResult({ outcome: 'failed', final: true, error: 'LGL 401' }) : checkOk),
  })
  s.start()
  await clock.advance(6 * MIN + 30_000)
  // Halted from 06:57:30; the nightly pass at 07:00 clears it. The count went
  // up on the halted ticks, so the 07:00:30 tick is the fifth.
  assert.deepEqual(times('vg-check'), [at('06:56:30'), at('06:57:30'), at('07:00:30'), at('07:01:30')])
  assert.deepEqual(times('lgl-check'), [at('07:00:30')])
  assert.deepEqual(lines.filter((l) => !l.startsWith('SYNC ALIVE')), ['PASS FAILED vg-check LGL 401', 'CHECK RECOVERED vg-check'])
  await s.stop()
})

test('a full pass that clears a halt starts the failure clock afresh', async () => {
  // The vg check fails from 06:41:30, then a final error at 06:44:30 halts it. The nightly pass at
  // 07:00 clears the halt; the next check fails once more and is not taken for a run since 06:41:30.
  const fails = new Set([at('06:41:30'), at('06:42:30'), at('06:43:30'), at('07:00:30')])
  const { clock, lines, s } = checkSetup(at('06:40:30'), {
    check: async (kind, opts, c) => {
      if (kind !== 'vg-check') return checkOk
      if (iso(c.now()) === at('06:44:30')) return checkResult({ outcome: 'failed', final: true, error: 'LGL 401' })
      return fails.has(iso(c.now())) ? checkResult({ outcome: 'failed', error: 'VG down' }) : checkOk
    },
  })
  s.start()
  await clock.advance(21 * MIN + 30_000)
  assert.deepEqual(lines.filter((l) => !l.startsWith('SYNC ALIVE')), [
    'CHECK FAILED vg-check VG down', 'CHECK FAILED vg-check VG down', 'CHECK FAILED vg-check VG down',
    'PASS FAILED vg-check LGL 401',
    'CHECK FAILED vg-check VG down',
    'CHECK RECOVERED vg-check', // the halt's PASS FAILED still gets its recovery line
  ])
  await s.stop()
})

test('the breaker halts checks until a full pass succeeds', async () => {
  // Tripped at 06:56:30. The nightly pass fails; its retry at 08:00 succeeds.
  const passes = [ok, failedRetryable]
  const { clock, lines, times, s } = checkSetup(at('06:55:30'), {
    full: async () => passes.shift() ?? ok,
    check: async (kind, opts, c) => (kind === 'vg-check' && iso(c.now()) === at('06:56:30')
      ? checkResult({ outcome: 'failed', breaker: true, foundChange: true, error: 'circuit breaker: too many' }) : checkOk),
  })
  s.start()
  await clock.advance(66 * MIN)
  assert.deepEqual(times('vg-check'), [at('06:56:30'), at('08:00:30'), at('08:01:30')])
  assert.equal(times('lgl-check').length, 1) // 08:00:30: the count went on while halted
  assert.ok(lines.includes('PASS FAILED vg-check circuit breaker: too many'))
  await s.stop()
})

test('a 429 puts the lgl check off for five minutes', async () => {
  // The 12:08 vg check is rate-limited: LGL reads pause until 12:13. The vg
  // checks during the pause fail without being rate-limited themselves, so
  // the pause is not extended. The lgl check due at 12:10 runs at 12:13.
  const { clock, checks, times, s } = checkSetup(at('12:00:00'), {
    check: async (kind, opts, c) => {
      if (kind === 'vg-check' && iso(c.now()) === at('12:08:00')) return checkResult({ outcome: 'failed', rateLimited: true, error: 'LGL 429' })
      if (opts.lglPaused) return checkResult({ outcome: 'failed', error: 'LGL rate-limited' })
      return checkOk
    },
  })
  s.start()
  await clock.advance(19 * MIN)
  assert.deepEqual(times('lgl-check'), [at('12:05:00'), at('12:13:00'), at('12:18:00')])
  assert.deepEqual(checks.filter((c) => c.lglPaused).map((c) => c.at), [at('12:09:00'), at('12:10:00'), at('12:11:00'), at('12:12:00')])
  await s.stop()
})

test('stop during the lgl check of a tick', async () => {
  // The vg check of the 12:05 tick succeeds; its lgl check is mid-read when
  // the service stops, and answers stopped.
  let release
  const { clock, lines, checks, s } = checkSetup(at('12:00:00'), {
    check: (kind, opts, c) => (kind === 'lgl-check' ? new Promise((r) => { release = r }) : Promise.resolve(checkOk)),
  })
  s.start()
  await clock.advance(5 * MIN + 10_000)
  assert.deepEqual(checks.slice(-2).map((c) => [c.kind, c.at]), [['vg-check', at('12:05:00')], ['lgl-check', at('12:05:00')]])
  let stopped = false
  const done = s.stop().then(() => { stopped = true })
  await clock.settle()
  assert.equal(stopped, false)
  release(checkResult({ outcome: 'stopped' }))
  await done
  assert.equal(lines.at(-1), 'CHECK STOPPED lgl-check shutdown')
  assert.equal(clock.pending(), 0)
  const count = checks.length
  await clock.advance(24 * HOUR)
  assert.equal(checks.length, count)
})

test('a stopped check schedules nothing after it', async () => {
  const { clock, lines, checks, s } = checkSetup(at('12:00:00'), {
    check: async () => checkResult({ outcome: 'stopped', error: 'shutdown' }),
  })
  s.start()
  await clock.advance(24 * HOUR)
  assert.deepEqual(checks.map((c) => c.kind), ['vg-check'])
  assert.equal(lines[0], 'CHECK STOPPED vg-check shutdown')
  await s.stop()
  assert.equal(clock.pending(), 0)
})

test('a runCheck that throws counts as a failed check', async () => {
  const { clock, lines, times, s } = checkSetup(at('12:00:00'), {
    check: async (kind) => { if (kind === 'vg-check') throw new Error('boom'); return checkOk },
  })
  s.start()
  await clock.advance(5 * MIN)
  assert.equal(lines[0], 'CHECK FAILED vg-check boom')
  assert.deepEqual(times('lgl-check'), [at('12:05:00')])
  await s.stop()
})

test('SYNC ALIVE shows both check times and lgl-every', async () => {
  const { clock, lines, s } = checkSetup(at('12:00:00'))
  s.start()
  await clock.advance(10 * MIN)
  const tail = (l) => l.slice(l.indexOf(' last-vg-check'))
  assert.deepEqual(lines.map(tail), [
    // the heartbeat at 12:05 fires before the 12:05 tick
    ' last-vg-check=2026-11-15T12:04:00.000Z last-lgl-check=none lgl-every=5m',
    ' last-vg-check=2026-11-15T12:09:00.000Z last-lgl-check=2026-11-15T12:05:00.000Z lgl-every=5m',
  ])
  await clock.advance(55 * MIN)
  assert.equal(tail(lines.at(-1)), ' last-vg-check=2026-11-15T13:04:00.000Z last-lgl-check=2026-11-15T12:55:00.000Z lgl-every=15m')
  await s.stop()
})

test('without runCheck, no tick is armed', async () => {
  const { clock, s } = setup('2026-11-15T12:00:00Z', async () => ok)
  s.start()
  await clock.advance(0)
  assert.equal(clock.pending(), 2) // the nightly and the heartbeat
  await s.stop()
})
