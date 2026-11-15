// Command line for the LGL <-> VG service (no command: the scheduler; writes to VG only with WRITE_VG=true),
// one full pass by hand (--once full, dry unless --write-vg), the report (writes nothing to LGL or VG), the
// one-time load of the import's decisions (dry unless --write-vg) and the service-account setup (records the
// account's own privacy acknowledgement in VG, only on request).

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig } from './config.js'
import { createLglClient } from './lgl.js'
import { createVgClient } from './vg.js'
import { buildReport } from './report.js'
import { parsePolicy } from './policy.js'
import { runFullPass } from './pass.js'
import { importSeed } from './seed.js'
import { startService } from './service.js'

const USAGE = `Usage:
  node src/lgl-vg/main.js
  node src/lgl-vg/main.js --once full [--write-vg] [--max-people <n>] [--out <dir>] [--snapshot <file>]
  node src/lgl-vg/main.js report [--out <dir>] [--save-snapshot] [--snapshot <file>]
  node src/lgl-vg/main.js seed-import --file <import-run.json> [--write-vg]
  node src/lgl-vg/main.js setup [--acknowledge-privacy]
With no command it runs as the service: a full pass at start and nightly at
FULL_PASS_UTC, writing to VG only when WRITE_VG=true, until SIGTERM or SIGINT.
Any command also takes --env <file> (default .env). Variables already set in the
environment are not overridden by the file.`

export function envFileFrom(argv) {
  const rest = []
  let file = '.env'
  let explicit = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--env') {
      const v = argv[++i]
      if (v === undefined) throw new Error('--env needs a file')
      file = v
      explicit = true
    } else rest.push(argv[i])
  }
  return { file, explicit, rest }
}

function parseOptions(args) {
  const opts = { out: 'out', saveSnapshot: false, snapshot: null }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--save-snapshot') opts.saveSnapshot = true
    else if (a === '--out' || a === '--snapshot') {
      const v = args[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      if (a === '--out') opts.out = v
      else opts.snapshot = v
    } else throw new Error(`Unknown option ${a}`)
  }
  return opts
}

async function readSnapshot(read, path) {
  let snap
  try {
    snap = JSON.parse(await read(path))
  } catch {
    throw new Error(`Snapshot ${path} is not valid JSON`)
  }
  if (!Array.isArray(snap?.constituents) || !Array.isArray(snap?.gifts)) {
    throw new Error(`Snapshot ${path} has no constituents or gifts`)
  }
  return snap
}

function parseFullOptions(args) {
  const opts = { out: 'out', snapshot: null, writeVg: false, maxPeople: null }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--write-vg') opts.writeVg = true
    else if (a === '--out' || a === '--snapshot' || a === '--max-people') {
      const v = args[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      if (a === '--out') opts.out = v
      else if (a === '--snapshot') opts.snapshot = v
      else {
        if (!/^[1-9]\d*$/.test(v)) throw new Error('--max-people must be a positive whole number')
        opts.maxPeople = Number(v)
      }
    } else throw new Error(`Unknown option ${a}`)
  }
  if (opts.snapshot && opts.writeVg) {
    throw new Error('A snapshot cannot be used to write: it would write stale LGL values into VG. Drop --snapshot or --write-vg.')
  }
  return opts
}

async function full(argv, { env, fetchImpl = fetch, sleep, now, stdout, writeFile: write, readFile: read }) {
  let opts
  try {
    opts = parseFullOptions(argv)
  } catch (err) {
    stdout(err.message)
    return 2
  }
  try {
    const config = loadConfig(env)
    const policy = parsePolicy(await read(config.policyFile))
    const snapshot = opts.snapshot ? await readSnapshot(read, opts.snapshot) : null
    const vg = createVgClient({ ...config.vg, fetchImpl, now })
    const lgl = snapshot ? null : createLglClient({ apiKey: config.lgl.apiKey, fetchImpl, sleep })
    return await runFullPass({
      config, policy, vg, lgl, snapshot, writeVg: opts.writeVg, maxPeople: opts.maxPeople,
      now, writeLines: write, stdout, out: opts.out,
    })
  } catch (err) {
    stdout(`PASS FAILED full ${err.message}`)
    return 1
  }
}

function parseSeedOptions(args) {
  const opts = { file: null, writeVg: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--write-vg') opts.writeVg = true
    else if (a === '--file') {
      opts.file = args[++i]
      if (opts.file === undefined) throw new Error('--file needs a value')
    } else throw new Error(`Unknown option ${a}`)
  }
  if (!opts.file) throw new Error('seed-import needs --file <the import run file, import-prod-*.json>')
  return opts
}

// Loads the import's skip and hold decisions as holds (seed.js). The file holds real data; nothing
// from it is printed but counts.
async function seedImport(argv, { env, fetchImpl = fetch, now, stdout, readFile: read }) {
  let opts
  try {
    opts = parseSeedOptions(argv)
  } catch (err) {
    stdout(err.message)
    return 2
  }
  try {
    let run
    try {
      run = JSON.parse(await read(opts.file))
    } catch {
      throw new Error(`${opts.file} is not readable JSON`)
    }
    if (!Array.isArray(run?.actions)) throw new Error(`${opts.file} has no actions; is it an import run file?`)
    if (run.executed !== true) throw new Error(`${opts.file} is a dry run of the import (executed is not true)`)
    const config = loadConfig(env)
    const vg = createVgClient({ ...config.vg, fetchImpl, now })
    await vg.whoAmI()
    const persons = await vg.listPersons()
    const holds = await vg.getSyncHolds(['open', 'dismissed', 'closed'])
    const { items, counts } = importSeed(run.actions, { persons, holds })
    stdout(JSON.stringify({ target: run.target ?? null, actions: run.actions.length, toLoad: items.length, counts }, null, 2))
    if (opts.writeVg && items.length) await vg.createSyncHolds(items)
    stdout(`SEED OK ${opts.writeVg ? 'write-vg' : 'dry-run'} loaded=${opts.writeVg ? items.length : 0} planned=${items.length}`)
    return 0
  } catch (err) {
    stdout(`SEED FAILED ${err.message}`)
    return 1
  }
}

function parseSetupOptions(args) {
  const opts = { acknowledgePrivacy: false }
  for (const a of args) {
    if (a === '--acknowledge-privacy') opts.acknowledgePrivacy = true
    else throw new Error(`Unknown option ${a}`)
  }
  return opts
}

async function setup(argv, { env, fetchImpl = fetch, now, stdout }) {
  try {
    const opts = parseSetupOptions(argv)
    const config = loadConfig(env)
    const vg = createVgClient({ ...config.vg, fetchImpl, now })

    const me = await vg.whoAmI() // also creates the user row on the account's first request
    stdout(`Signed in as ${me.username} (user id ${me.userId})`)

    const status = await vg.privacyStatus()
    if (status.needsAck === true) {
      if (!opts.acknowledgePrivacy) {
        stdout('Privacy acknowledgement is owed. Run again with --acknowledge-privacy.')
        return 1
      }
      const rules = await vg.currentPrivacyRules()
      await vg.acknowledgePrivacy(rules.id)
      stdout('Privacy acknowledgement recorded.')
    }

    try {
      await vg.listPersons()
    } catch (err) {
      if (err.status === 403) {
        stdout(`${me.username} has no role grant. Grant it the Staff role at federation level in VG, then run setup again.`)
      } else {
        stdout(err.message)
      }
      return 1
    }

    stdout('SETUP OK')
    return 0
  } catch (err) {
    stdout(`SETUP FAILED: ${err.message}`)
    return 1
  }
}

// The service: start-up, then the scheduler until SIGTERM or SIGINT. Resolves 0 once stopped, 1 if it
// could not start. The clients are created once and serve every pass. The signal handlers are registered
// before start-up (a process with no handler that runs as PID 1 ignores SIGTERM): a signal during start-up
// stops at once, since nothing has been written yet; the caller exits, abandoning the checks in flight.
async function service({
  env, fetchImpl = fetch, sleep, now, stdout, writeFile: write, readFile: read,
  onSignal, setTimer, clearTimer, fs,
}) {
  let svc = null
  let stopping = false
  let finish
  const finished = new Promise((resolve) => { finish = resolve })
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    stdout('STOPPING')
    if (svc) await svc.stop()
    stdout('STOPPED')
    finish(0)
  }
  onSignal('SIGTERM', shutdown)
  onSignal('SIGINT', shutdown)

  let config, policy, vg, lgl
  try {
    config = loadConfig(env)
    policy = parsePolicy(await read(config.policyFile))
    vg = createVgClient({ ...config.vg, fetchImpl, now })
    lgl = createLglClient({ apiKey: config.lgl.apiKey, fetchImpl, sleep })
  } catch (err) {
    stdout(`STARTUP FAILED ${err.message}`)
    return 1
  }
  startService({ config, policy, vg, lgl, stdout, now, setTimer, clearTimer, sleep, writeLines: write, fs })
    .then(async (started) => {
      if (stopping) await started?.stop() // stopped during start-up: stop the scheduler it just started
      else if (!started) finish(1)
      else svc = started
    })
  return finished
}

export async function run(argv, deps) {
  const { env, fetchImpl = fetch, sleep, now, stdout, writeFile: write, readFile: read } = deps
  if (argv.length === 0) return service(deps)
  if (argv[0] === '--once') {
    if (argv[1] === 'full') return full(argv.slice(2), deps)
    if (argv[1] === 'vg-check' || argv[1] === 'lgl-check') {
      stdout('The VG and LGL checks arrive in step 6.')
      return 2
    }
    stdout(USAGE)
    return 2
  }
  if (argv[0] === 'setup') return setup(argv.slice(1), deps)
  if (argv[0] === 'seed-import') return seedImport(argv.slice(1), deps)
  if (argv[0] !== 'report') {
    stdout(USAGE)
    return 2
  }
  try {
    const opts = parseOptions(argv.slice(1))
    const config = loadConfig(env)
    const nowMs = now()
    const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-')

    const vg = createVgClient({ ...config.vg, fetchImpl, now })
    await vg.whoAmI() // fail on a sign-in problem before the long LGL pull

    let constituents, gifts
    if (opts.snapshot) {
      ;({ constituents, gifts } = await readSnapshot(read, opts.snapshot))
    } else {
      const lgl = createLglClient({ apiKey: config.lgl.apiKey, fetchImpl, sleep })
      constituents = await lgl.pullConstituents()
      gifts = await lgl.pullGifts()
      if (opts.saveSnapshot) {
        const pulledAt = new Date(nowMs).toISOString()
        await write(`${opts.out}/lgl-snapshot-${stamp}.json`, JSON.stringify({ pulledAt, constituents, gifts }))
      }
    }
    const persons = await vg.listPersons()

    const today = new Date(nowMs).toISOString().slice(0, 10)
    const { summary, details } = buildReport({ constituents, gifts, persons, config, today })
    const detailPath = `${opts.out}/report-${stamp}.jsonl`
    await write(detailPath, details.map((d) => JSON.stringify(d)).join('\n') + (details.length ? '\n' : ''))
    stdout(JSON.stringify(summary, null, 2))
    stdout(`Details: ${detailPath}`)
    return 0
  } catch (err) {
    stdout(`REPORT FAILED: ${err.message}`)
    return 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let envArgs
  try {
    envArgs = envFileFrom(process.argv.slice(2))
  } catch (err) {
    console.log(err.message)
    process.exit(1)
  }
  if (existsSync(envArgs.file)) process.loadEnvFile(envArgs.file)
  else if (envArgs.explicit) {
    console.log(`No such env file: ${envArgs.file}`)
    process.exit(1)
  }
  const code = await run(envArgs.rest, {
    env: process.env,
    fetchImpl: fetch,
    now: Date.now,
    onSignal: (name, fn) => process.on(name, fn),
    stdout: (t) => console.log(t),
    writeFile: async (p, text) => {
      await mkdir(dirname(p), { recursive: true })
      await writeFile(p, text)
    },
    readFile: (p) => readFile(p, 'utf8'),
  })
  // The service exits at once: a pass stopped mid-read leaves its request (and any backoff) behind.
  if (envArgs.rest.length === 0) process.exit(code)
  process.exitCode = code
}
