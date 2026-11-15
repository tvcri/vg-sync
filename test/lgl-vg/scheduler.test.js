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
  assert.equal(lines.at(-1), 'SYNC ALIVE last-full=2026-11-14T08:00:00.000Z result=failed next-full=2026-11-15T07:00:00.000Z')
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
    'SYNC ALIVE last-full=2026-11-14T08:00:00.000Z result=failed next-full=2026-11-14T09:00:00.000Z',
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
    'SYNC ALIVE last-full=2026-11-14T08:00:00.000Z result=failed next-full=2026-11-15T07:00:00.000Z',
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
  assert.deepEqual(lines, ['SYNC ALIVE last-full=none result=running next-full=2026-11-14T07:00:00.000Z'])
  await clock.advance(2 * HOUR)
  assert.equal(lines.at(-1), 'SYNC ALIVE last-full=2026-11-14T08:00:00.000Z result=running next-full=2026-11-15T07:00:00.000Z')
  await stopAll(clock, s)
})

test('the heartbeat before the first pass and after an ok', async () => {
  const { clock, lines, s } = setup('2026-11-14T12:00:00Z', async () => ok)
  s.start()
  await clock.advance(10 * 60_000)
  assert.deepEqual(lines, [
    'SYNC ALIVE last-full=2026-11-14T12:00:00.000Z result=ok next-full=2026-11-15T07:00:00.000Z',
    'SYNC ALIVE last-full=2026-11-14T12:00:00.000Z result=ok next-full=2026-11-15T07:00:00.000Z',
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
  assert.equal(lines.at(-1), 'SYNC ALIVE last-full=none result=none next-full=none')
  await s.stop()
  assert.equal(clock.pending(), 0)
})
