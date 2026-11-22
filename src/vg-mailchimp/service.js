// The long-lived service: the start-up checks and markers, then the scheduler, which runs the job nightly
// (and at once). Each run gets its own AbortController: a ceiling of RUN_TIMEOUT_MINUTES aborts it with
// 'timeout', stop() aborts it with 'shutdown'. After each run, old records files are deleted.
//
// The clock, timers, sleep, file system and clients are injected, so this is tested without waiting.

import { readdir as fsReaddir, stat as fsStat, unlink as fsUnlink, writeFile as fsWriteFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runOnce } from './run.js'
import { createScheduler } from './scheduler.js'

const DAY_MS = 86_400_000
// Start-up checks VG, then Mailchimp. Each check gets up to three tries, 20 s apart, each try with up to 15 s.
// Both share one budget of 80 s, so start-up ends inside the deployer's 90-second health gate.
const STARTUP_BUDGET_MS = 80_000
const STARTUP_TRIES = 3
const STARTUP_DELAY_MS = 20_000
const STARTUP_TIMEOUT_MS = 15_000
const STARTUP_MIN_TRY_MS = 1_000 // a try with less time than this is not worth starting
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const defaultFs = { readdir: fsReaddir, stat: fsStat, unlink: fsUnlink }

// Deletes the records files (mailchimp-*.jsonl and audience-*.json) in dir older than keepDays. Returns the count.
export async function pruneRecords({ dir, keepDays, now, readdir, stat, unlink }) {
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
    if (!/^(mailchimp-.*\.jsonl|audience-.*\.json)$/.test(name)) continue
    const path = join(dir, name)
    if ((await stat(path)).mtimeMs < cutoff) {
      await unlink(path)
      deleted++
    }
  }
  return deleted
}

// Tries fn(timeoutMs) up to three times, 20 seconds apart, within the shared start-up deadline. A final
// error is not retried. When the deadline leaves no room for another try, it fails with the last error.
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
  config, vg, mc, stdout, now, setTimer = setTimeout, clearTimer = clearTimeout,
  sleep = defaultSleep, writeFile = fsWriteFile, fs = defaultFs,
}) {
  try {
    const deadline = now() + STARTUP_BUDGET_MS
    let me
    try {
      me = await withTries((timeoutMs) => vg.whoAmI({ timeoutMs }), {
        sleep, now, deadline, isFinal: (err) => err?.final === true || err?.status === 403,
      })
    } catch (err) {
      throw new Error(`VG sign-in failed: ${err?.message ?? err}`)
    }
    stdout(`STARTUP VG signed in as ${me.username}`)
    let list
    try {
      list = await withTries(() => mc.getList(), {
        sleep, now, deadline, isFinal: (err) => err?.final === true || err?.status === 401,
      })
    } catch (err) {
      throw new Error(`Mailchimp not reached: ${err?.message ?? err}`)
    }
    // A mock with no expected name (the rehearsal) skips the name check.
    const skipName = config.mailchimp.mock && config.mailchimp.listName === ''
    if (!skipName && list.name !== config.mailchimp.listName) {
      throw new Error(`Mailchimp audience name is "${list.name}", expected "${config.mailchimp.listName}"`)
    }
    stdout(`STARTUP Mailchimp audience ${list.name} reached`)
  } catch (err) {
    stdout(`STARTUP FAILED ${err.message}`)
    return null
  }

  let current = null // the running job's AbortController
  let stopping = false

  async function runJob() {
    const controller = new AbortController()
    current = controller
    if (stopping) controller.abort('shutdown')
    const timer = setTimer(() => controller.abort('timeout'), config.runTimeoutMinutes * 60_000)
    let result
    try {
      result = await runOnce({
        config, vg, mc, now, sleep, writeFile, stdout, signal: controller.signal,
        writeAdd: config.writeAdd, writeArchive: config.writeArchive, maxAdd: config.maxAdd, maxArchive: config.maxArchive,
      })
    } finally {
      clearTimer(timer)
      current = null
    }
    if (result.outcome !== 'stopped') {
      try {
        await pruneRecords({ dir: config.outDir, keepDays: config.recordsKeepDays, now, ...fs })
      } catch (err) {
        stdout(`Old records files were not deleted: ${err?.message ?? err}`)
      }
    }
    return { outcome: result.outcome, retryable: result.retryable }
  }

  const scheduler = createScheduler({ now, setTimer, clearTimer, runUtc: config.runUtc, runJob, stdout })
  stdout(`STARTUP scheduler started write-add=${config.writeAdd ? 'on' : 'off'} write-archive=${config.writeArchive ? 'on' : 'off'} nightly=${config.runUtc}Z`)
  scheduler.start()

  return {
    async stop() {
      stopping = true
      current?.abort('shutdown')
      await scheduler.stop()
    },
  }
}
