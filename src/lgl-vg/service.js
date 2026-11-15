// The long-lived service: the start-up checks and markers, then the scheduler, which runs the full pass
// nightly (and at once). Each pass gets its own AbortController: a ceiling of PASS_TIMEOUT_MINUTES aborts it
// with 'timeout', stop() aborts it with 'shutdown'. After each pass, old decisions files are deleted.
//
// The clock, timers, sleep, file system and clients are injected, so this is tested without waiting.

import { readdir as fsReaddir, stat as fsStat, unlink as fsUnlink } from 'node:fs/promises'
import { join } from 'node:path'
import { runFullPass } from './pass.js'
import { createScheduler } from './scheduler.js'

const DAY_MS = 86_400_000
const STARTUP_TRIES = 3
const STARTUP_DELAY_MS = 20_000
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const defaultFs = { readdir: fsReaddir, stat: fsStat, unlink: fsUnlink }

// Deletes the full pass's decisions files (full-*.jsonl) in dir older than keepDays. Returns the count.
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
    if (!/^full-.*\.jsonl$/.test(name)) continue
    const path = join(dir, name)
    if ((await stat(path)).mtimeMs < cutoff) {
      await unlink(path)
      deleted++
    }
  }
  return deleted
}

// Tries fn three times in all, 20 seconds apart. A final error (a refused sign-in) is not retried.
async function withTries(fn, sleep) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (err?.final === true || attempt >= STARTUP_TRIES) throw err
      await sleep(STARTUP_DELAY_MS)
    }
  }
}

export async function startService({
  config, policy, vg, lgl, stdout, now, setTimer = setTimeout, clearTimer = clearTimeout,
  sleep = defaultSleep, writeLines, fs = defaultFs,
}) {
  try {
    let me
    try {
      me = await withTries(() => vg.whoAmI(), sleep)
    } catch (err) {
      throw new Error(`VG sign-in failed: ${err?.message ?? err}`)
    }
    stdout(`STARTUP VG signed in as ${me.username}`)
    try {
      await withTries(() => lgl.probe(), sleep)
    } catch (err) {
      throw new Error(`LGL not reached: ${err?.message ?? err}`)
    }
    stdout('STARTUP LGL reached')
  } catch (err) {
    stdout(`STARTUP FAILED ${err.message}`)
    return null
  }

  let current = null // the running pass's AbortController
  let stopping = false

  async function runFull() {
    const controller = new AbortController()
    current = controller
    if (stopping) controller.abort('shutdown')
    const timer = setTimer(() => controller.abort('timeout'), config.passTimeoutMinutes * 60_000)
    let result = { outcome: 'failed', retryable: true }
    try {
      await runFullPass({
        config, policy, vg, lgl, snapshot: null, writeVg: config.writeVg, maxPeople: null,
        now, writeLines, stdout, out: config.outDir, signal: controller.signal, quiet: true,
        onResult: (r) => { result = r },
      })
    } finally {
      clearTimer(timer)
      current = null
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

  const scheduler = createScheduler({ now, setTimer, clearTimer, fullPassUtc: config.fullPassUtc, runFull, stdout })
  stdout(`STARTUP scheduler started write-vg=${config.writeVg ? 'on' : 'off'} nightly=${config.fullPassUtc}Z`)
  scheduler.start()

  return {
    async stop() {
      stopping = true
      current?.abort('shutdown')
      await scheduler.stop()
    },
  }
}
