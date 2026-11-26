import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextNightly, createScheduler } from '../../src/jotform-vg/scheduler.js'

const iso = (ms) => new Date(ms).toISOString()
const HOUR = 3_600_000
const MIN = 60_000

// A fake clock and timer queue. advance(ms) fires due timers in time order (ties in the order they were
// set), letting microtasks settle between them.
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

function setup(startIso, impl, opts = {}) {
  const clock = fakeClock(startIso)
  const lines = []
  const calls = []
  const runJob = (kind) => {
    calls.push(`${kind} ${iso(clock.now())}`)
    return impl(kind, clock)
  }
  const s = createScheduler({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    fullRunUtc: '08:00', changeEveryMs: 5 * MIN, runJob, stdout: (l) => lines.push(l), ...opts,
  })
  return { clock, lines, calls, s }
}

// Stops the scheduler while a job may still be running: the fake clock has to move for it to return.
async function stopAll(clock, s) {
  const done = s.stop()
  await clock.advance(7 * 24 * HOUR)
  await done
}

const after = (clock, ms, result) => new Promise((r) => clock.setTimer(() => r(result), ms))
const ok = { outcome: 'ok', retryable: false }
const failedRetryable = { outcome: 'failed', retryable: true }

test('nextNightly: later the same day, and the next day at the time itself', () => {
  assert.equal(iso(nextNightly(Date.parse('2026-11-14T06:59:00Z'), '08:00')), '2026-11-14T08:00:00.000Z')
  assert.equal(iso(nextNightly(Date.parse('2026-11-14T08:00:00Z'), '08:00')), '2026-11-15T08:00:00.000Z')
})

test('start runs a full pass; a change pass follows changeEveryMs after it, and the next after that one ends', async () => {
  const { clock, calls, s } = setup('2026-11-14T12:00:00Z', (kind, c) => after(c, kind === 'change' ? MIN : 0, ok))
  s.start()
  await clock.advance(0)
  assert.deepEqual(calls, ['full 2026-11-14T12:00:00.000Z'])
  await clock.advance(5 * MIN)
  assert.deepEqual(calls, ['full 2026-11-14T12:00:00.000Z', 'change 2026-11-14T12:05:00.000Z'])
  await clock.advance(5 * MIN) // the change ended at 12:06; the next is armed for 12:11
  assert.equal(calls.length, 2)
  await clock.advance(MIN)
  assert.equal(calls.at(-1), 'change 2026-11-14T12:11:00.000Z')
  await stopAll(clock, s)
})

test('no change pass runs before a full pass has succeeded', async () => {
  const { clock, calls, s } = setup('2026-11-14T09:00:00Z', async () => failedRetryable)
  s.start()
  await clock.advance(30 * MIN)
  assert.deepEqual(calls, ['full 2026-11-14T09:00:00.000Z'])
  await stopAll(clock, s)
})

test('changes begin after a retried full pass succeeds', async () => {
  let n = 0
  const { clock, calls, s } = setup('2026-11-14T09:00:00Z', async () => (++n === 1 ? failedRetryable : ok))
  s.start()
  await clock.advance(HOUR + 6 * MIN)
  assert.deepEqual(calls, ['full 2026-11-14T09:00:00.000Z', 'full 2026-11-14T10:00:00.000Z', 'change 2026-11-14T10:05:00.000Z'])
  await stopAll(clock, s)
})

test('a failed full pass retries hourly, three times, then waits for night', async () => {
  const { clock, calls, s } = setup('2026-11-14T09:00:00Z', async () => failedRetryable)
  s.start()
  await clock.advance(23 * HOUR + 30 * MIN)
  assert.deepEqual(calls, [
    'full 2026-11-14T09:00:00.000Z', 'full 2026-11-14T10:00:00.000Z', 'full 2026-11-14T11:00:00.000Z',
    'full 2026-11-14T12:00:00.000Z', 'full 2026-11-15T08:00:00.000Z',
  ])
  await stopAll(clock, s)
})

test('a failed change pass waits for the next tick and does not retry hourly', async () => {
  let n = 0
  const { clock, calls, lines, s } = setup('2026-11-14T09:00:00Z', async (kind) => (kind === 'full' || ++n > 1 ? ok : failedRetryable))
  s.start()
  await clock.advance(5 * MIN)
  assert.equal(calls.length, 2)
  await clock.advance(MIN)
  await clock.advance(5 * MIN)
  assert.deepEqual(calls.slice(1), ['change 2026-11-14T09:05:00.000Z', 'change 2026-11-14T09:10:00.000Z'])
  await stopAll(clock, s)
})

test('at fullRunUtc a full pass is queued behind a running change and runs right after it', async () => {
  const { clock, calls, s } = setup('2026-11-14T07:50:00Z', (kind, c) => after(c, kind === 'change' ? 12 * MIN : 0, ok))
  s.start()
  await clock.advance(0)
  await clock.advance(20 * MIN) // change starts 07:55, runs to 08:07
  assert.deepEqual(calls, ['full 2026-11-14T07:50:00.000Z', 'change 2026-11-14T07:55:00.000Z', 'full 2026-11-14T08:07:00.000Z'])
  await stopAll(clock, s)
})

test('a queued full goes before a queued change', async () => {
  // The start pass is quick; the change tick (3 h) is armed. The 08:00 full runs 30 hours, so while it runs the
  // change tick fires (a change queues) and the next night's 08:00 queues a full. The full goes first.
  let n = 0
  const { clock, calls, s } = setup('2026-11-14T07:00:00Z', (kind, c) => after(c, ++n === 2 ? 30 * HOUR : 0, ok), { changeEveryMs: 3 * HOUR })
  s.start()
  await clock.advance(0)
  await clock.advance(HOUR + 1) // the 08:00 full starts, running to 14:00 the next day
  await clock.advance(30 * HOUR)
  assert.deepEqual(calls.slice(0, 4), [
    'full 2026-11-14T07:00:00.000Z', 'full 2026-11-14T08:00:00.000Z', 'full 2026-11-15T14:00:00.000Z', 'change 2026-11-15T14:00:00.000Z',
  ])
  await stopAll(clock, s)
})

test('heartbeat prints every 5 minutes while a job runs; result is none, ok or failed', async () => {
  const { clock, lines, s } = setup('2026-11-14T06:00:00Z', (kind, c) => after(c, 12 * MIN, ok), { changeEveryMs: HOUR })
  s.start()
  await clock.advance(10 * MIN)
  assert.deepEqual(lines, ['JOTFORM ALIVE last=none result=none', 'JOTFORM ALIVE last=none result=none'])
  await clock.advance(5 * MIN)
  assert.equal(lines.at(-1), 'JOTFORM ALIVE last=2026-11-14T06:00:00.000Z result=ok')
  await stopAll(clock, s)
})

test('heartbeat shows result=failed after a failed pass', async () => {
  const { clock, lines, s } = setup('2026-11-14T09:00:00Z', async () => failedRetryable)
  s.start()
  await clock.advance(5 * MIN)
  assert.equal(lines.at(-1), 'JOTFORM ALIVE last=2026-11-14T09:00:00.000Z result=failed')
  await stopAll(clock, s)
})

test('a rejected runJob counts as a retryable failure and prints no message', async () => {
  const { clock, calls, lines, s } = setup('2026-11-14T09:00:00Z', async () => { throw new Error('boom Jane Doe') })
  s.start()
  await clock.advance(5 * MIN)
  assert.deepEqual(lines, ['JOTFORM FAILED scheduler error', 'JOTFORM ALIVE last=2026-11-14T09:00:00.000Z result=failed'])
  await clock.advance(HOUR)
  assert.equal(calls.length, 2)
  await stopAll(clock, s)
})

test('a stopped outcome schedules nothing', async () => {
  const { clock, calls, s } = setup('2026-11-14T06:00:00Z', async () => ({ outcome: 'stopped', retryable: false }))
  s.start()
  await clock.advance(3 * 24 * HOUR)
  assert.equal(calls.length, 1)
  await stopAll(clock, s)
})

test('stop clears the timers and schedules nothing more', async () => {
  const { clock, calls, s } = setup('2026-11-14T06:00:00Z', async () => ok)
  s.start()
  await clock.advance(0)
  await stopAll(clock, s)
  assert.equal(clock.pending(), 0)
  await clock.advance(3 * 24 * HOUR)
  assert.equal(calls.length, 1)
})
