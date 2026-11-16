// Scenario loading, relative dates and selection. Pure: no I/O.

const SCENARIO_KEYS = new Set(['name', 'why', 'since', 'vg', 'lgl', 'gifts', 'link', 'couple', 'phases', 'overnight', 'runAlone', 'known', 'importDecision'])
// The import review's decisions a scenario can start with (loaded by the real seed-import command).
export const IMPORT_DECISIONS = new Set(['staff-skip', 'horizon-skip', 'hold'])
const PHASE_KEYS = new Set(['run', 'edit', 'wait', 'args', 'env', 'expect', 'known'])
const REQUIRED = ['name', 'why', 'since', 'phases']
// What a phase's pass runs: the full pass, or one change check (step 6). A check reads the cursor the
// scenario's own earlier full pass set, so a check phase belongs only to a scenario that runs alone.
export const RUNS = new Set(['full', 'lgl-check', 'vg-check'])

// '-30d', '+0d', '-2y' from today ('YYYY-MM-DD'); a literal 'YYYY-MM-DD' passes through.
export function resolveDate (spec, today) {
  if (typeof spec === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(spec)) return spec
  const m = typeof spec === 'string' ? /^([+-])(\d+)([dy])$/.exec(spec) : null
  if (!m) throw new Error(`Not a date or an offset: ${JSON.stringify(spec)}`)
  const d = new Date(`${today}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) throw new Error(`Not a date: ${JSON.stringify(today)}`)
  const n = Number(m[2]) * (m[1] === '-' ? -1 : 1)
  if (m[3] === 'd') d.setUTCDate(d.getUTCDate() + n)
  else d.setUTCFullYear(d.getUTCFullYear() + n)
  return d.toISOString().slice(0, 10)
}

// modules: [{ area, default: [scenario, ...] }] (or `scenarios` in place of `default`).
// Returns a flat list; each scenario gets its `area`.
export function loadScenarios (modules) {
  const list = []
  const seen = new Set()
  for (const mod of modules) {
    const items = mod.default ?? mod.scenarios
    if (!Array.isArray(items)) throw new Error(`Scenario file "${mod.area}" has no scenario list`)
    for (const s of items) {
      const label = s?.name ?? '(no name)'
      for (const k of REQUIRED) {
        if (s?.[k] === undefined || s[k] === null || s[k] === '') throw new Error(`Scenario "${label}" in "${mod.area}" is missing "${k}"`)
      }
      for (const k of Object.keys(s)) {
        if (!SCENARIO_KEYS.has(k)) throw new Error(`Scenario "${s.name}" has an unknown key "${k}"`)
      }
      if (s.runAlone !== undefined && s.runAlone !== true && s.runAlone !== false && (typeof s.runAlone !== 'string' || !s.runAlone.trim())) {
        throw new Error(`Scenario "${s.name}": runAlone must be true or a group name`)
      }
      if (!Array.isArray(s.phases)) throw new Error(`Scenario "${s.name}": phases must be a list`)
      if (s.importDecision !== undefined && !IMPORT_DECISIONS.has(s.importDecision)) {
        throw new Error(`Scenario "${s.name}": importDecision must be one of ${[...IMPORT_DECISIONS].join(', ')}`)
      }
      s.phases.forEach((p, i) => {
        if (p === null || typeof p !== 'object' || Array.isArray(p)) throw new Error(`Scenario "${s.name}" phase ${i + 1} is not an object`)
        for (const k of Object.keys(p ?? {})) {
          if (!PHASE_KEYS.has(k)) throw new Error(`Scenario "${s.name}" phase ${i + 1} has an unknown key "${k}"`)
        }
        if (p.run !== undefined && !RUNS.has(p.run)) throw new Error(`Scenario "${s.name}" phase ${i + 1}: run must be one of ${[...RUNS].join(', ')}, not ${JSON.stringify(p.run)}`)
        if (p.run !== undefined && p.run !== 'full' && !s.runAlone) throw new Error(`Scenario "${s.name}" phase ${i + 1}: run ${p.run} is allowed only on a runAlone scenario`)
        // Phase args and an expected pass failure change the pass for everyone in it, so they belong
        // only to a scenario that runs alone.
        if (p.args !== undefined && !s.runAlone) throw new Error(`Scenario "${s.name}" phase ${i + 1}: args are allowed only on a runAlone scenario`)
        // Phase env: variables the pass's service sees on top of the env file (a variable already set
        // wins over the file), e.g. a narrower LGL_WRITE_ALLOW.
        if (p.env !== undefined) {
          if (p.env === null || typeof p.env !== 'object' || Array.isArray(p.env) || Object.values(p.env).some((v) => typeof v !== 'string')) {
            throw new Error(`Scenario "${s.name}" phase ${i + 1}: env must map variable names to strings`)
          }
          if (!s.runAlone) throw new Error(`Scenario "${s.name}" phase ${i + 1}: env is allowed only on a runAlone scenario`)
        }
        if (p.expect?.passFails !== undefined) {
          if (p.expect.passFails !== true) throw new Error(`Scenario "${s.name}" phase ${i + 1}: passFails must be true when given`)
          if (!s.runAlone) throw new Error(`Scenario "${s.name}" phase ${i + 1}: passFails is allowed only on a runAlone scenario`)
        }
      })
      if (seen.has(s.name)) throw new Error(`Duplicate scenario name "${s.name}"`)
      seen.add(s.name)
      list.push({ ...s, area: mod.area })
    }
  }
  return list
}

export function selectScenarios (list, { only, step = 7, overnight = false } = {}) {
  const wanted = only == null ? null : [].concat(only)
  const selected = []
  const skipped = []
  for (const s of list) {
    if (wanted && !wanted.includes(s.name) && !wanted.includes(s.area)) continue
    if (s.since > step) skipped.push({ name: s.name, reason: `since step ${s.since}` })
    else if (s.overnight && !overnight) skipped.push({ name: s.name, reason: 'overnight' })
    else selected.push(s)
  }
  return { selected, skipped }
}

export function phaseCount (selected) {
  return selected.reduce((n, s) => Math.max(n, s.phases.length), 0)
}
