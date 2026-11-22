import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextNightly, createScheduler } from '../../src/vg-mailchimp/scheduler.js'

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
    runUtc: '08:00', runJob: runFull, stdout: (l) => lines.push(l), ...opts,
  })
  return { clock, lines, calls, s }
}

const after = (clock, ms, result) => new Promise((r) => clock.setTimer(() => r(result), ms))
const ok = { outcome: 'ok', retryable: false }
const failedRetryable = { outcome: 'failed', retryable: true }
const failedFinal = { outcome: 'failed', retryable: false }

test('nextNightly: later the same day, and the next day at the time itself', () => {
  assert.equal(iso(nextNightly(Date.parse('2026-11-14T06:59:00Z'), '08:00')), '2026-11-14T08:00:00.000Z')
  assert.equal(iso(nextNightly(Date.parse('2026-11-14T08:00:00Z'), '08:00')), '2026-11-15T08:00:00.000Z')
})

test('start runs at once, then at the next 08:00Z', async () => {
  const { clock, calls, s } = setup('2026-11-14T12:00:00Z', async () => ok)
  s.start()
  await clock.advance(0)
  assert.deepEqual(calls, ['2026-11-14T12:00:00.000Z'])
  await clock.advance(2 * 24 * HOUR)
  assert.deepEqual(calls, ['2026-11-14T12:00:00.000Z', '2026-11-15T08:00:00.000Z', '2026-11-16T08:00:00.000Z'])
  await s.stop()
})

test('a retryable failure retries hourly, three times, then waits for night', async () => {
  const { clock, calls, s } = setup('2026-11-14T09:00:00Z', async () => failedRetryable)
  s.start()
  await clock.advance(23 * HOUR + 30 * 60_000)
  assert.deepEqual(calls, [
    '2026-11-14T09:00:00.000Z', '2026-11-14T10:00:00.000Z', '2026-11-14T11:00:00.000Z',
    '2026-11-14T12:00:00.000Z', '2026-11-15T08:00:00.000Z',
  ])
  await s.stop()
})

test('a nightly run gets its own three retries', async () => {
  const { clock, calls, s } = setup('2026-11-14T06:30:00Z', async () => failedRetryable)
  s.start()
  await clock.advance(5 * HOUR)
  assert.deepEqual(calls.slice(-4), [
    '2026-11-14T08:00:00.000Z', '2026-11-14T09:00:00.000Z', '2026-11-14T10:00:00.000Z', '2026-11-14T11:00:00.000Z',
  ])
  await s.stop()
})

test('a non-retryable failure does not retry', async () => {
  const { clock, calls, lines, s } = setup('2026-11-14T09:00:00Z', async () => failedFinal)
  s.start()
  await clock.advance(5 * 60_000)
  assert.equal(lines.at(-1), 'MAILCHIMP ALIVE last=2026-11-14T09:00:00.000Z result=failed next=2026-11-15T08:00:00.000Z')
  await clock.advance(23 * HOUR)
  assert.deepEqual(calls, ['2026-11-14T09:00:00.000Z', '2026-11-15T08:00:00.000Z'])
  await s.stop()
})

test('a rejected runJob counts as a retryable failure; ALIVE shows the retry time', async () => {
  const { clock, calls, lines, s } = setup('2026-11-14T09:00:00Z', async () => { throw new Error('boom') })
  s.start()
  await clock.advance(5 * 60_000)
  assert.deepEqual(lines, [
    'MAILCHIMP FAILED boom',
    'MAILCHIMP ALIVE last=2026-11-14T09:00:00.000Z result=failed next=2026-11-14T10:00:00.000Z',
  ])
  await clock.advance(HOUR)
  assert.equal(calls.length, 2)
  await s.stop()
})

test('heartbeat prints every 5 minutes while a job runs, with result=running', async () => {
  const { clock, lines, s } = setup('2026-11-14T06:00:00Z', (c) => after(c, 12 * 60_000, ok))
  s.start()
  await clock.advance(10 * 60_000)
  assert.deepEqual(lines, [
    'MAILCHIMP ALIVE last=none result=running next=2026-11-14T08:00:00.000Z',
    'MAILCHIMP ALIVE last=none result=running next=2026-11-14T08:00:00.000Z',
  ])
  await clock.advance(5 * 60_000)
  assert.equal(lines.at(-1), 'MAILCHIMP ALIVE last=2026-11-14T06:00:00.000Z result=ok next=2026-11-14T08:00:00.000Z')
  await s.stop()
})

test('a stopped outcome schedules nothing', async () => {
  const { clock, calls, s } = setup('2026-11-14T06:00:00Z', async () => ({ outcome: 'stopped', retryable: false }))
  s.start()
  await clock.advance(3 * 24 * HOUR)
  assert.equal(calls.length, 1)
  await s.stop()
})

test('stop clears the timers and schedules nothing more', async () => {
  const { clock, calls, s } = setup('2026-11-14T06:00:00Z', async () => ok)
  s.start()
  await clock.advance(0)
  await s.stop()
  assert.equal(clock.pending(), 0)
  await clock.advance(3 * 24 * HOUR)
  assert.equal(calls.length, 1)
})
