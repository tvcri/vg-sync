#!/usr/bin/env node
// The runner: guards, reseed, then every selected scenario's phases in lockstep
// against the LGL trial account and the dev VG, one real service pass per phase.
//
//   npm run harness -- [--only <name|area>] [--step N] [--overnight] [--resume] [--guards-only] [--seed-only]
//   (--step defaults to 7)
//
// --seed-only: reseed, seed the playground (harness/playground.js), or the --only scenarios' starting
// records, run one full pass that writes both sides, print who was seeded, and stop. For running the
// service by hand against the same targets.
//
// Every run reseeds unless --resume. Records are left in place after a run for
// inspection; the next run wipes them first. planRun is pure and unit-tested;
// everything else here talks to the live systems, and only after the guards pass.

import { spawn } from 'node:child_process'
import { createWriteStream, readFileSync, readdirSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'
import { runGuards } from './guards.js'
import { createLglWriter } from './lgl-write.js'
import { createVgStaff } from './vg-staff.js'
import { reseedVg, serviceEnv } from './vg-db.js'
import { STATE_FILE, applyEdit, seedScenarios, wipeLgl } from './seed.js'
import { loadScenarios, phaseCount, resolveDate, selectScenarios } from './scenario.js'
import { checkScenario } from './expect.js'
import { PLAYGROUND } from './playground.js'
import { createLglClient } from '../src/lgl-vg/lgl.js'

const REPO = new URL('..', import.meta.url).pathname
const ENV_FILE = '.env.harness'
const SCENARIO_DIR = join(REPO, 'harness/scenarios')
const VERIFY_POLL_MS = 60_000
const VERIFY_LIMIT_MS = 15 * 60_000

const asList = (v) => (v === undefined || v === null ? [] : [].concat(v))

// --- Pure parts -------------------------------------------------------------

export function parseArgs (argv) {
  const opts = { only: null, step: 7, overnight: false, resume: false, guardsOnly: false, seedOnly: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--overnight') opts.overnight = true
    else if (a === '--resume') opts.resume = true
    else if (a === '--guards-only') opts.guardsOnly = true
    else if (a === '--seed-only') opts.seedOnly = true
    else if (a === '--only') {
      const v = argv[++i]
      if (!v || v.startsWith('--')) throw new Error('--only needs a scenario name or area')
      opts.only = [...(opts.only ?? []), v]
    } else if (a === '--step') {
      const v = argv[++i]
      if (!/^\d+$/.test(v ?? '')) throw new Error('--step needs a whole number')
      opts.step = Number(v)
    } else throw new Error(`Unknown option ${a}`)
  }
  if (opts.seedOnly && (opts.resume || opts.overnight)) throw new Error('--seed-only takes neither --resume nor --overnight')
  return opts
}

// The ordered steps of a run. Lockstep group first: one reseed, then for each
// phase every scenario's edit, then its wait, then one pass, then a check of
// every scenario in the group (a phase past a scenario's end checks it is
// undisturbed). Then each runAlone scenario: its own reseed and its own passes.
// runAlone scenarios that share a group name (runAlone: 'name') run as one
// group, in lockstep with each other only, where the first of them stands.
// phaseCount is the lockstep group's (the runAlone scenarios have their own).
// A pass step's `run` is what the phase runs ('full', 'lgl-check' or 'vg-check';
// 'full' when no scenario in the group names one); scenarios of one group that
// name different runs for the same phase are an error.
export function planRun ({ selected, phaseCount: count }) {
  const lockstep = selected.filter((s) => !s.runAlone)
  const alone = []
  const named = new Map()
  for (const s of selected.filter((x) => x.runAlone)) {
    if (s.runAlone === true) { alone.push([s]); continue }
    if (!named.has(s.runAlone)) { named.set(s.runAlone, []); alone.push(named.get(s.runAlone)) }
    named.get(s.runAlone).push(s)
  }
  const steps = []
  let pass = 0
  const group = (scenarios, n) => {
    steps.push({ kind: 'reseed', scenarios: scenarios.map((s) => s.name) })
    const importing = scenarios.filter((s) => s.importDecision)
    if (importing.length) steps.push({ kind: 'seed-import', scenarios: importing.map((s) => s.name) })
    for (let p = 0; p < n; p++) {
      for (const s of scenarios) if (s.phases[p]?.edit) steps.push({ kind: 'edit', scenario: s.name, phase: p })
      for (const s of scenarios) if (s.phases[p]?.wait) steps.push({ kind: 'wait', scenario: s.name, phase: p, wait: s.phases[p].wait })
      const args = []
      for (const s of scenarios) {
        const a = asList(s.phases[p]?.args).map(String)
        if (a.length && !includesRun(args, a)) args.push(...a)
      }
      const runs = [...new Set(scenarios.map((s) => s.phases[p]?.run).filter((r) => r !== undefined))]
      if (runs.length > 1) throw new Error(`Scenarios ${scenarios.map((s) => s.name).join(', ')} name different runs for phase ${p + 1}: ${runs.join(', ')}`)
      const env = {}
      for (const s of scenarios) {
        for (const [k, v] of Object.entries(s.phases[p]?.env ?? {})) {
          if (k in env && env[k] !== v) throw new Error(`Scenarios ${scenarios.map((x) => x.name).join(', ')} set env ${k} differently for phase ${p + 1}`)
          env[k] = v
        }
      }
      pass++
      const expectFail = scenarios.some((s) => s.phases[p]?.expect?.passFails === true)
      steps.push({ kind: 'pass', pass, phase: p, run: runs[0] ?? 'full', args, env, expectFail })
      for (const s of scenarios) steps.push({ kind: 'check', scenario: s.name, phase: p, pass })
    }
  }
  if (lockstep.length) group(lockstep, count ?? phaseCount(lockstep))
  for (const g of alone) group(g, phaseCount(g))
  return steps
}

function includesRun (list, run) {
  for (let i = 0; i + run.length <= list.length; i++) {
    if (run.every((x, j) => list[i + j] === x)) return true
  }
  return false
}

// The LGL side of donor and lastGiftDate, from the gifts the harness made: the
// seeded ones plus those added by edits up to and including this phase.
export function lglDonor (scenario, phaseIndex, today) {
  const gifts = [...asList(scenario.gifts)]
  scenario.phases.slice(0, phaseIndex + 1).forEach((p) => gifts.push(...asList(p?.edit?.lgl?.gifts)))
  const dates = gifts.filter((g) => !g.dues).map((g) => resolveDate(g.date, today)).sort()
  return { donor: dates.length > 0, lastGiftDate: dates.length ? dates[dates.length - 1] : null }
}

// This scenario's rows from the pass's decisions file and from /sync/holds.
export function scenarioRows ({ constituentId, personIds }, { decisions, holds }) {
  const people = new Set(personIds.map(String))
  // A person-level hold is this scenario's when it names one of its people or its constituent (a person
  // the sync created for it, or linked to it); a constituent-level hold when it names its constituent.
  const mine = (personId, cid) => (personId != null && people.has(String(personId))) || String(cid) === String(constituentId)
  return {
    decisions: decisions.filter((d) => people.has(String(d.personId)) || String(d.constituentId) === String(constituentId)),
    holds: holds.filter((h) => mine(h.personId, h.lglConstituentId)),
  }
}

// The import run file seed-import reads, in the import's own shape, for the scenarios that start
// with an import decision. lastGiftDate is the newest seeded gift that is not dues.
export function importRun (scenarios, state, today) {
  const REASONS = {
    'staff-skip': { kind: 'skip', reason: 'Staff chose Skip' },
    'horizon-skip': { kind: 'skip', reason: 'Last gift before the horizon; new people only for gifts since' },
    hold: { kind: 'hold', reason: 'Not confirmed on the Work list' },
  }
  const actions = scenarios.filter((s) => s.importDecision).map((s) => {
    const id = String(state.scenarios[s.name].constituentId)
    const dates = asList(s.gifts).filter((g) => !g.dues).map((g) => resolveDate(g.date, today)).sort()
    return { key: id, lglId: id, name: s.name, ...REASONS[s.importDecision], lastGiftDate: dates.at(-1) ?? null }
  })
  return { target: 'harness', executed: true, actions }
}

// --- Live parts -------------------------------------------------------------

const localToday = () => new Date().toLocaleDateString('en-CA') // YYYY-MM-DD, local time
const stampOf = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-')

async function loadScenarioModules () {
  const files = readdirSync(SCENARIO_DIR).filter((f) => f.endsWith('.js')).sort()
  const modules = []
  for (const f of files) {
    const mod = await import(pathToFileURL(join(SCENARIO_DIR, f)).href)
    modules.push({ area: basename(f, '.js'), default: mod.default, scenarios: mod.scenarios })
  }
  return modules
}

// The service's argv for one pass: writes to VG and to LGL (LGL_WRITE_ALLOW in .env.harness limits which constituents).
export function passArgv ({ command, args }) {
  // seed-import takes no --write-lgl (it rejects it); only the --once pass and check commands do.
  const lgl = command[0] === '--once' ? ['--write-lgl'] : []
  return ['src/lgl-vg/main.js', ...command, '--env', ENV_FILE, '--write-vg', ...lgl, ...args]
}

// The service's environment for one pass: ours without the variables the example file names (so the env
// file wins), then the phase's env on top (a variable already set wins over the file).
export function passEnv (baseEnv, exampleText, phaseEnv = {}) {
  return { ...serviceEnv(baseEnv, exampleText), ...phaseEnv }
}

// Runs one pass (or one change check) as a child process; its output goes to the screen and to the log.
function runPass ({ dir, args, env = {}, log, run = 'full', command = ['--once', run, '--out', dir], logName = `${basename(dir)}.log` }) {
  const exampleText = readFileSync(join(REPO, '.env.harness.example'), 'utf8')
  const argv = passArgv({ command, args })
  if (Object.keys(env).length) log(`  with ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  log(`$ node ${argv.join(' ')}`)
  return new Promise((resolve, reject) => {
    const file = createWriteStream(join(dir, logName))
    const child = spawn(process.execPath, argv, { cwd: REPO, env: passEnv(process.env, exampleText, env), stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (d) => { process.stdout.write(d); file.write(d) })
    child.stderr.on('data', (d) => { process.stderr.write(d); file.write(d) })
    child.on('error', (err) => { file.end(); reject(err) })
    child.on('close', (code) => file.end(() => resolve(code)))
  })
}

// The pass's decisions: a full pass's full-*.jsonl or, failing that, a check's checks-*.jsonl
// (a check that found nothing writes no file).
async function readDecisions (dir) {
  const names = await readdir(dir)
  let files = names.filter((f) => /^full-.*\.jsonl$/.test(f)).sort()
  if (!files.length) files = names.filter((f) => /^checks-.*\.jsonl$/.test(f)).sort()
  if (!files.length) return null
  const text = await readFile(join(dir, files[files.length - 1]), 'utf8')
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

async function getConstituentOrNull (lglWriter, id) {
  try {
    return await lglWriter.getConstituent(id)
  } catch (err) {
    if (/→ 404\b/.test(err.message)) return null
    throw err
  }
}

async function waitForVerification (lglWriter, constituentId, log) {
  const started = Date.now()
  for (;;) {
    const list = await lglWriter.listEntries(constituentId, 'street_addresses')
    if (!list.length) return 'the constituent has no address'
    if (list.every((a) => a.verified_on)) return null
    if (Date.now() - started >= VERIFY_LIMIT_MS) return 'not set after 15 minutes'
    log(`  waiting for LGL address verification on constituent ${constituentId} ...`)
    await new Promise((resolve) => setTimeout(resolve, VERIFY_POLL_MS))
  }
}

function formatValue (v) {
  return typeof v === 'string' ? v : JSON.stringify(v)
}

// A scenario whose failures all fall in phases marked `known` (or a scenario marked `known`)
// is KNOWN, not FAIL, and does not fail the run. A known phase that passes is pointed out,
// so its note can be removed.
export function formatReport ({ selected, results, passFailures }) {
  const lines = []
  let passed = 0
  let known = 0
  for (const s of selected) {
    const failures = results[s.name] ?? []
    const noteOf = (phase) => s.phases?.[phase - 1]?.known ?? s.known
    if (!failures.length) {
      passed++
      lines.push(`PASS ${s.name}`)
      ;(s.phases ?? []).forEach((p, i) => { if (p?.known) lines.push(`    phase ${i + 1} is marked known but passed: ${p.known}`) })
      continue
    }
    const isKnown = failures.every((f) => noteOf(f.phase))
    if (isKnown) known++
    lines.push(`${isKnown ? 'KNOWN' : 'FAIL'} ${s.name}`)
    if (isKnown) {
      for (const phase of [...new Set(failures.map((f) => f.phase))]) lines.push(`    phase ${phase} known: ${noteOf(phase)}`)
    }
    for (const f of failures) {
      lines.push(`    phase ${f.phase}  ${f.what}: expected ${formatValue(f.expected)}, found ${formatValue(f.found)}`)
    }
  }
  for (const p of passFailures) lines.push(`pass ${p.pass} exited ${p.code}`)
  lines.push(`${passed} passed, ${selected.length - passed - known} failed, ${known} known, ${passFailures.length} pass(es) exited non-zero`)
  return lines.join('\n')
}

// True when a scenario failed outside its known phases.
export function failedOutsideKnown (s, failures = []) {
  return failures.some((f) => !(s.phases?.[f.phase - 1]?.known ?? s.known))
}

export async function main (argv, { log = console.log } = {}) {
  process.chdir(REPO) // the state file and the pass's --out are relative to the repo
  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    log(`${err.message}\nUsage: npm run harness -- [--only <name|area>] [--step N] [--overnight] [--resume] [--guards-only] [--seed-only]`)
    return 2
  }
  const env = parseEnv(readFileSync(ENV_FILE, 'utf8'))
  const lglWriter = createLglWriter({ apiKey: env.LGL_API_KEY })

  const guards = await runGuards({ env, lglWriter, lglReader: createLglClient({ apiKey: env.LGL_API_KEY }) })
  if (!guards.ok) {
    log(`GUARDS FAILED:\n- ${guards.failed.join('\n- ')}`)
    return 1
  }
  log('Guards passed.')
  if (opts.guardsOnly) return 0

  const list = loadScenarios(await loadScenarioModules())
  if (opts.seedOnly) return seedOnly({ opts, list, env, lglWriter, log })
  let selected
  let saved = null
  if (opts.resume) {
    saved = JSON.parse(await readFile(STATE_FILE, 'utf8'))
    if (!saved.run) throw new Error(`${STATE_FILE} holds no run to resume`)
    const byName = new Map(list.map((s) => [s.name, s]))
    const missing = saved.run.names.filter((n) => !byName.has(n))
    if (missing.length) throw new Error(`The saved run names scenarios that no longer exist: ${missing.join(', ')}`)
    selected = saved.run.names.map((n) => byName.get(n))
  } else {
    const unmatched = asList(opts.only).filter((o) => !list.some((s) => s.name === o || s.area === o))
    if (unmatched.length) {
      log(`--only matched no scenario or area: ${unmatched.join(', ')}`)
      return 1
    }
    const sel = selectScenarios(list, { only: opts.only, step: opts.step, overnight: opts.overnight })
    for (const s of sel.skipped) log(`skipped ${s.name} (${s.reason})`)
    selected = sel.selected
  }
  if (!selected.length) {
    log('No scenario selected; nothing to run.')
    return 1
  }

  const steps = planRun({ selected, phaseCount: phaseCount(selected.filter((s) => !s.runAlone)) })
  const byName = new Map(selected.map((s) => [s.name, s]))
  const outDir = saved?.run.outDir ?? `out/harness-${stampOf()}`
  await mkdir(outDir, { recursive: true })
  const today = saved?.today ?? localToday()
  let state = saved ? { seededAt: saved.seededAt, today: saved.today, scenarios: saved.scenarios } : null
  const results = saved?.run.results ?? {}
  const passFailures = saved?.run.passFailures ?? []
  const fail = (name, phase, what, expected, found) => (results[name] ??= []).push({ phase: phase + 1, what, expected, found })

  const vgStaff = createVgStaff({
    apiUrl: env.VG_API_URL, oidcUrl: env.VG_OIDC_URL,
    clientId: env.HARNESS_VG_CLIENT_ID, clientSecret: env.HARNESS_VG_CLIENT_SECRET,
  })
  const saveRun = (nextStep) => writeFile(STATE_FILE, JSON.stringify({
    ...state, run: { names: selected.map((s) => s.name), nextStep, outDir, results, passFailures },
  }, null, 2) + '\n')

  const start = saved?.run.nextStep ?? 0
  if (saved) log(start < steps.length ? `Resuming ${outDir} at step ${start + 1} of ${steps.length}` : `The saved run in ${outDir} is complete; reporting it again`)
  if (steps[start]?.kind === 'check') throw new Error(`The saved run stopped between a pass and its checks (step ${start + 1}); rerun without --resume`)
  let pass = null // the current pass: { passStartedAt, decisions, holds }

  for (let i = start; i < steps.length; i++) {
    const step = steps[i]
    const s = byName.get(step.scenario)
    if (step.kind === 'reseed') {
      const group = step.scenarios.map((n) => byName.get(n))
      log(`\n== Reseed: ${step.scenarios.join(', ')}`)
      await wipeLgl({ lglWriter, log })
      await reseedVg(env, { envFile: join(REPO, ENV_FILE) })
      state = await seedScenarios(group, { lglWriter, vgStaff, env, today, log })
      await saveRun(i + 1)
    } else if (step.kind === 'seed-import') {
      const group = step.scenarios.map((n) => byName.get(n))
      const file = join(outDir, 'import-run.json')
      await writeFile(file, JSON.stringify(importRun(group, state, today), null, 2) + '\n')
      log(`\n== Seed the import's decisions: ${step.scenarios.join(', ')}`)
      const code = await runPass({ dir: outDir, args: [], log, command: ['seed-import', '--file', file], logName: 'seed-import.log' })
      if (code !== 0) for (const sc of group) fail(sc.name, 0, 'seed-import', 'exit 0', code)
    } else if (step.kind === 'edit') {
      log(`edit ${s.name} phase ${step.phase + 1}`)
      try {
        await applyEdit(s.phases[step.phase].edit, state.scenarios[s.name], { lglWriter, vgStaff, env, today })
      } catch (err) {
        fail(s.name, step.phase, 'edit', 'applied', err.message)
      }
    } else if (step.kind === 'wait') {
      if (step.wait === 'overnight') {
        await saveRun(i + 1)
        log(`\n${s.name} waits for LGL's overnight jobs. State saved; run again with --resume tomorrow.`)
        return 0
      }
      if (step.wait !== 'verification') {
        fail(s.name, step.phase, 'wait', "'verification' or 'overnight'", step.wait)
        continue
      }
      const problem = await waitForVerification(lglWriter, state.scenarios[s.name].constituentId, log)
      if (problem) fail(s.name, step.phase, 'wait: verification', 'verified_on on every address', problem)
    } else if (step.kind === 'pass') {
      const dir = join(outDir, `pass-${step.pass}`)
      await mkdir(dir, { recursive: true })
      log(`\n== Pass ${step.pass} (phase ${step.phase + 1}, ${step.run})`)
      const passStartedAt = new Date().toISOString()
      const code = await runPass({ dir, args: step.args, env: step.env, log, run: step.run })
      if (step.expectFail) log(`Pass ${step.pass} was expected to fail; it exited ${code}`)
      else if (code !== 0) passFailures.push({ pass: step.pass, code })
      const decisions = await readDecisions(dir)
      if (decisions === null) log(`Pass ${step.pass} wrote no decisions file`)
      pass = { passStartedAt, code, decisions: decisions ?? [], holds: await vgStaff.listHolds(['open', 'dismissed']) }
    } else if (step.kind === 'check') {
      const entry = state.scenarios[s.name]
      const vgPersons = []
      for (const id of entry.personIds) vgPersons.push(await vgStaff.getPerson(id))
      // A scenario with no VG person of its own is checked against the people linked to its constituent
      // (the person the sync created for it).
      if (!entry.personIds.length) vgPersons.push(...await vgStaff.getPersons(entry.constituentId))
      const lglConstituent = await getConstituentOrNull(lglWriter, entry.constituentId)
      if (lglConstituent) Object.assign(lglConstituent, lglDonor(s, step.phase, today))
      const rows = scenarioRows(entry, pass)
      // expect.lglLog: the people's written LGL log rows, newest first (read only when expected).
      let lglLog = []
      if (s.phases[step.phase]?.expect?.lglLog) {
        for (const p of vgPersons.filter(Boolean)) lglLog.push(...await vgStaff.getSyncLog({ personId: p.personId, outcome: 'written' }))
        lglLog = lglLog.sort((a, b) => Number(b.logId) - Number(a.logId))
      }
      const failures = checkScenario({
        scenario: s, phaseIndex: step.phase, vgPersons, // a person not found is null, which checkScenario reports as missing
        lglConstituent, holds: rows.holds, decisions: rows.decisions, passStartedAt: pass.passStartedAt,
        passExitCode: pass.code, today, lglLog,
        constituentIds: Object.fromEntries(Object.entries(state.scenarios).map(([n, e]) => [n, e.constituentId])),
      })
      for (const f of failures) (results[s.name] ??= []).push(f)
      if (steps[i + 1]?.kind !== 'check') await saveRun(i + 1)
    }
  }

  const report = formatReport({ selected, results, passFailures })
  await writeFile(join(outDir, 'report.txt'), report + '\n')
  log(`\n${report}\nReport: ${join(outDir, 'report.txt')}`)
  const anyFailed = selected.some((sc) => failedOutsideKnown(sc, results[sc.name]))
  return anyFailed || passFailures.length ? 1 : 0
}

// --seed-only: a clean starting point for running the service by hand. The pass that follows the seed
// writes both sides (as every harness pass does), so the people are linked and agreeing when it stops.
async function seedOnly ({ opts, list, env, lglWriter, log }) {
  let selected = loadScenarios([{ area: 'playground', default: PLAYGROUND }])
  if (opts.only) {
    const unmatched = opts.only.filter((o) => !list.some((s) => s.name === o || s.area === o))
    if (unmatched.length) {
      log(`--only matched no scenario or area: ${unmatched.join(', ')}`)
      return 1
    }
    selected = selectScenarios(list, { only: opts.only, step: opts.step, overnight: true }).selected
  }
  const outDir = `out/seed-${stampOf()}`
  await mkdir(outDir, { recursive: true })
  const today = localToday()
  const vgStaff = createVgStaff({
    apiUrl: env.VG_API_URL, oidcUrl: env.VG_OIDC_URL,
    clientId: env.HARNESS_VG_CLIENT_ID, clientSecret: env.HARNESS_VG_CLIENT_SECRET,
  })
  log(`\n== Reseed: ${selected.map((s) => s.name).join(', ')}`)
  await wipeLgl({ lglWriter, log })
  await reseedVg(env, { envFile: join(REPO, ENV_FILE) })
  const state = await seedScenarios(selected, { lglWriter, vgStaff, env, today, log })
  const importing = selected.filter((s) => s.importDecision)
  if (importing.length) {
    const file = join(outDir, 'import-run.json')
    await writeFile(file, JSON.stringify(importRun(importing, state, today), null, 2) + '\n')
    const code = await runPass({ dir: outDir, args: [], log, command: ['seed-import', '--file', file], logName: 'seed-import.log' })
    if (code !== 0) return code
  }
  log('\n== First pass (writes VG and LGL)')
  const code = await runPass({ dir: outDir, args: [], log })
  log('\nSeeded (LGL constituent -> VG people):')
  for (const s of selected) {
    const e = state.scenarios[s.name]
    log(`  ${s.name}: ${e.constituentId} -> ${e.personIds.join(', ') || '(none)'}`)
  }
  log(`\nFirst pass exited ${code}; its decisions are in ${outDir}.`)
  log('Run the service: WRITE_VG=true WRITE_LGL=true node src/lgl-vg/main.js --env .env.harness')
  log('The next harness run wipes these records.')
  return code
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (err) => {
    console.log(`HARNESS FAILED: ${err.stack ?? err.message}`)
    process.exitCode = 1
  })
}
