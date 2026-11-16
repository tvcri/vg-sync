// The long-lived service: the start-up checks and markers, then the scheduler, which runs the full pass
// nightly (and at once). Each pass gets its own AbortController: a ceiling of PASS_TIMEOUT_MINUTES aborts it
// with 'timeout', stop() aborts it with 'shutdown'. After each pass, old decisions files are deleted.
//
// The clock, timers, sleep, file system and clients are injected, so this is tested without waiting.

import { readdir as fsReaddir, stat as fsStat, unlink as fsUnlink } from 'node:fs/promises'
import { join } from 'node:path'
import { runFullPass } from './pass.js'
import { createScheduler } from './scheduler.js'
import { runCheck as runCheckOnce } from './check.js'

const DAY_MS = 86_400_000
// Start-up checks VG, then LGL. Each check gets up to three tries, 20 s apart, each try with up to 15 s.
// Both checks share one budget of 80 s, so start-up ends inside the deployer's 90-second health gate:
// a try gets min(15 s, the time left), and no try or sleep starts that could not finish inside the budget.
const STARTUP_BUDGET_MS = 80_000
const STARTUP_TRIES = 3
const STARTUP_DELAY_MS = 20_000
const STARTUP_TIMEOUT_MS = 15_000
const STARTUP_MIN_TRY_MS = 1_000 // a try with less time than this is not worth starting
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const defaultFs = { readdir: fsReaddir, stat: fsStat, unlink: fsUnlink }

// Deletes the decisions files (full-*.jsonl and checks-*.jsonl) in dir older than keepDays. Returns the count.
export async function pruneDecisions({ dir, keepDays, now, readdir, stat, unlink }) {
  let names
  try {
    names = await readdir(dir)
  } catch (err) {
    if (err?.code === 'ENOENT') return 0
    throw err
  }
  const cutoff = now() - keepDays * DAY_MS
  let deleted = 0
  for (const name of names) {
    if (!/^(full|checks)-.*\.jsonl$/.test(name)) continue
    const path = join(dir, name)
    if ((await stat(path)).mtimeMs < cutoff) {
      await unlink(path)
      deleted++
    }
  }
  return deleted
}

// Tries fn(timeoutMs) up to three times, 20 seconds apart, within the shared start-up deadline. A final
// error (a refused sign-in, a bad LGL key, or what isFinal picks out) is not retried. When the deadline
// leaves no room for another try, it fails with the last error.
async function withTries(fn, { sleep, now, deadline, isFinal = (err) => err?.final === true }) {
  const ranOut = (last) =>
    new Error(`start-up time ran out (${STARTUP_BUDGET_MS / 1000} s)${last ? `; last error: ${last.message ?? last}` : ''}`)
  for (let attempt = 1; ; attempt++) {
    const left = deadline - now()
    if (left < STARTUP_MIN_TRY_MS) throw ranOut(null)
    try {
      return await fn(Math.min(STARTUP_TIMEOUT_MS, left))
    } catch (err) {
      if (isFinal(err) || attempt >= STARTUP_TRIES) throw err
      if (now() + STARTUP_DELAY_MS + STARTUP_MIN_TRY_MS > deadline) throw ranOut(err)
      await sleep(STARTUP_DELAY_MS)
    }
  }
}

export async function startService({
  config, policy, vg, lgl, stdout, now, setTimer = setTimeout, clearTimer = clearTimeout,
  sleep = defaultSleep, writeLines, fs = defaultFs,
}) {
  try {
    const deadline = now() + STARTUP_BUDGET_MS
    let me
    try {
      // A 403 here means the account lacks a role grant, the privacy acknowledgement or the scope: the
      // error says which to check, and retrying will not help.
      me = await withTries((timeoutMs) => vg.whoAmI({ timeoutMs }), {
        sleep, now, deadline, isFinal: (err) => err?.final === true || err?.status === 403,
      })
    } catch (err) {
      throw new Error(`VG sign-in failed: ${err?.message ?? err}`)
    }
    stdout(`STARTUP VG signed in as ${me.username}`)
    let reached
    try {
      reached = await withTries((timeoutMs) => lgl.probe({ timeoutMs }), { sleep, now, deadline })
    } catch (err) {
      throw new Error(`LGL not reached: ${err?.message ?? err}`)
    }
    stdout(`STARTUP LGL reached${reached?.rateLimited ? ' (rate-limited)' : ''}`)
  } catch (err) {
    stdout(`STARTUP FAILED ${err.message}`)
    return null
  }

  let current = null // the running pass's AbortController
  let currentCheck = null // the running check's AbortController
  // The LGL cache and the cursors, set by each successful full pass and moved on by the checks.
  const state = { cache: null, lglCursor: null, vgCursor: null }
  let stopping = false

  async function runFull() {
    const controller = new AbortController()
    current = controller
    if (stopping) controller.abort('shutdown')
    const timer = setTimer(() => controller.abort('timeout'), config.passTimeoutMinutes * 60_000)
    let result = { outcome: 'failed', retryable: true }
    try {
      await runFullPass({
        config, policy, vg, lgl, snapshot: null, writeVg: config.writeVg, maxPeople: null, vgCursorFrom: state.vgCursor,
        now, writeLines, stdout, out: config.outDir, signal: controller.signal, quiet: true,
        onResult: (r) => { result = r },
      })
    } finally {
      clearTimer(timer)
      current = null
    }
    if (result.outcome === 'ok' && result.lgl) {
      state.cache = {
        constituents: new Map(result.lgl.constituents.map((c) => [String(c.id), c])),
        gifts: new Map(result.lgl.gifts.map((g) => [String(g.id), g])),
      }
      state.lglCursor = result.lglCursor
      state.vgCursor = result.vgCursor
    }
    if (result.outcome !== 'stopped') {
      try {
        await pruneDecisions({ dir: config.outDir, keepDays: config.decisionsKeepDays, now, ...fs })
      } catch (err) {
        stdout(`Old decisions files were not deleted: ${err?.message ?? err}`)
      }
    }
    return { outcome: result.outcome, retryable: result.retryable }
  }

  // One check, with its own ceiling: a timeout resolves failed (check.js), a shutdown resolves stopped.
  async function runCheck(kind, { lglPaused = false } = {}) {
    const controller = new AbortController()
    currentCheck = controller
    if (stopping) controller.abort('shutdown')
    const timer = setTimer(() => controller.abort('timeout'), config.checkTimeoutMinutes * 60_000)
    try {
      return await runCheckOnce({
        kind, state, config, policy, vg, lgl, writeVg: config.writeVg, now, writeLines, stdout,
        out: config.outDir, signal: controller.signal, lglAttempts: 1, lglPaused, quiet: true,
      })
    } finally {
      clearTimer(timer)
      currentCheck = null
    }
  }

  const scheduler = createScheduler({ now, setTimer, clearTimer, fullPassUtc: config.fullPassUtc, runFull, stdout, runCheck })
  const allowText = (a) => (a === 'all' ? 'all' : a.size ? `${a.size} ids` : 'none')
  stdout(`STARTUP scheduler started write-vg=${config.writeVg ? 'on' : 'off'} write-lgl=${config.writeLgl ? 'on' : 'off'} allow=${allowText(config.lglWriteAllow)} nightly=${config.fullPassUtc}Z`)
  scheduler.start()

  return {
    async stop() {
      stopping = true
      current?.abort('shutdown')
      currentCheck?.abort('shutdown')
      await scheduler.stop()
    },
  }
}
