#!/usr/bin/env node
// Spike, throwaway: can LGL's constituent search tell us what changed?
//
// READ-ONLY. Makes about five GET requests to LGL and writes nothing anywhere.
// Prints counts, timings, constituent ids and timestamps. No names or contact
// values are printed.
//
// Usage:
//   node spike/lgl-updated-from.mjs --env ~/dev/tvcri/vg-utils/lgl-import/.env
//   node spike/lgl-updated-from.mjs --env <path> --days 30
//   node spike/lgl-updated-from.mjs --env <path> --since 2026-11-01
//
// Questions it answers:
//   1. Does q[]=updated_from=<date> return the constituents whose updated_at is
//      on or after that date, and only those?
//   2. Does editing an address, email or phone move the constituent's own
//      updated_at? (Judged from history: sub-records newer than their parent.)
//   3. If not, does updated_from still return those constituents?
//   4. Does updated_from honor a time of day, or only a date?
//   5. How long do the constituents-only pull and the filtered search take,
//      and does LGL send any rate-limit headers?

const BASE = 'https://api.littlegreenlight.com/api/v1'
const PAGE = 1000
const EXPAND = 'email_addresses,street_addresses,phone_numbers'
const SUBS = ['street_addresses', 'email_addresses', 'phone_numbers']

const args = process.argv.slice(2)
const arg = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const envPath = arg('--env') ?? '.env'
process.loadEnvFile(envPath.replace(/^~(?=\/)/, process.env.HOME))
const apiKey = process.env.LGL_API_KEY
if (!apiKey) throw new Error(`LGL_API_KEY is not set in ${envPath}`)
const auth = 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64')

const days = Number(arg('--days') ?? 7)
const since = arg('--since') ?? new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10)

let requests = 0
const seenHeaders = new Map()

async function get(path, params) {
  const url = new URL(BASE + path)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  const started = performance.now()
  const res = await fetch(url, { headers: { Authorization: auth } })
  const ms = Math.round(performance.now() - started)
  requests++
  for (const [k, v] of res.headers) {
    if (/rate|retry|limit|throttl/i.test(k)) seenHeaders.set(k, v)
  }
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, ms, json, text }
}

async function getAll(label, params) {
  const items = []
  let total = null
  let ms = 0
  for (let offset = 0; ; ) {
    const r = await get('/constituents/search', { ...params, limit: PAGE, offset })
    ms += r.ms
    if (r.status !== 200 || !r.json) {
      console.log(`  ${label}: HTTP ${r.status} after ${r.ms} ms: ${r.text.slice(0, 200)}`)
      return { ok: false, items, total, ms, status: r.status }
    }
    total = r.json.total_items
    items.push(...r.json.items)
    console.log(`  ${label}: offset ${offset}, ${r.json.items.length} items, ${r.ms} ms`)
    if (r.json.items.length === 0 || items.length >= total) break
    offset += r.json.items.length
  }
  return { ok: items.length === total, items, total, ms, status: 200 }
}

const t = (s) => (s ? Date.parse(s) : NaN)
const newestSub = (c) => {
  let best = { at: -Infinity, kind: null }
  for (const kind of SUBS) {
    for (const s of c[kind] ?? []) {
      const at = Math.max(t(s.updated_at) || -Infinity, t(s.created_at) || -Infinity)
      if (at > best.at) best = { at, kind }
    }
  }
  return best
}
const show = (ids, byId, limit = 10) =>
  ids.slice(0, limit).map((id) => {
    const c = byId.get(id)
    const sub = c ? newestSub(c) : null
    return `    ${id}  constituent ${c?.updated_at ?? '(not in full pull)'}` +
      (sub && sub.kind ? `  newest ${sub.kind} ${new Date(sub.at).toISOString()}` : '')
  }).join('\n') + (ids.length > limit ? `\n    ... and ${ids.length - limit} more` : '')

// 1. Ground truth: every constituent with its sub-records.
console.log(`\n[1] Full constituents pull (expand=${EXPAND})`)
const full = await getAll('full', { expand: EXPAND })
if (!full.ok) throw new Error('Full pull failed or was incomplete; nothing else can be judged.')
const byId = new Map(full.items.map((c) => [c.id, c]))
console.log(`  ${full.items.length} constituents in ${(full.ms / 1000).toFixed(1)} s`)

// 2. Do sub-record edits move the parent's updated_at?
console.log('\n[2] Sub-records newer than their constituent (more than 60 s)')
const SLACK = 60e3
const subNewer = full.items.filter((c) => newestSub(c).at > t(c.updated_at) + SLACK)
const byKind = {}
for (const c of subNewer) byKind[newestSub(c).kind] = (byKind[newestSub(c).kind] ?? 0) + 1
console.log(`  ${subNewer.length} of ${full.items.length} constituents`, byKind)
console.log(subNewer.length
  ? '  => Some sub-record changes did NOT move the constituent timestamp. Examples:\n' +
    show(subNewer.map((c) => c.id), byId, 5)
  : '  => No evidence either way from history: every sub-record is as old as its parent or older.')

// 3. The filter, by date.
console.log(`\n[3] Search with q[]=updated_from=${since}`)
const filtered = await getAll('filtered', { 'q[]': `updated_from=${since}`, expand: EXPAND })
if (filtered.status !== 200) {
  console.log('  => The filter was rejected. updated_from is not usable in this form.')
} else {
  const got = new Set(filtered.items.map((c) => c.id))
  const expected = new Set(full.items.filter((c) => (c.updated_at ?? '').slice(0, 10) >= since).map((c) => c.id))
  const missing = [...expected].filter((id) => !got.has(id))
  const extra = [...got].filter((id) => !expected.has(id))
  console.log(`  returned ${got.size} (total_items ${filtered.total}) in ${(filtered.ms / 1000).toFixed(1)} s`)
  console.log(`  expected ${expected.size} by constituent updated_at (UTC date >= ${since})`)
  console.log(`  missing from the filter: ${missing.length}`)
  if (missing.length) console.log(show(missing, byId))
  console.log(`  returned but not expected: ${extra.length}`)
  if (extra.length) console.log(show(extra, byId))
  if (got.size === full.items.length) console.log('  => The filter returned everyone: it was probably ignored.')

  // Constituents whose only recent change is on a sub-record.
  const sinceMs = Date.parse(since + 'T00:00:00Z')
  const subOnly = full.items.filter((c) =>
    (c.updated_at ?? '').slice(0, 10) < since && newestSub(c).at >= sinceMs)
  const subOnlyReturned = subOnly.filter((c) => got.has(c.id))
  console.log(`  constituents changed since ${since} ONLY on a sub-record: ${subOnly.length}, ` +
    `of which the filter returned ${subOnlyReturned.length}`)
}

// 4. Does it honor a time of day? Ask for "since one hour before the newest change".
console.log('\n[4] Search with a date and time')
const newest = full.items.map((c) => t(c.updated_at)).filter(Number.isFinite).sort((a, b) => b - a)[0]
const stamp = new Date(newest - 3600e3).toISOString().replace(/\.\d+Z$/, 'Z')
const expectedTimed = full.items.filter((c) => t(c.updated_at) >= newest - 3600e3).length
const expectedDay = full.items.filter((c) => (c.updated_at ?? '').slice(0, 10) >= stamp.slice(0, 10)).length
const timed = await get('/constituents/search', { 'q[]': `updated_from=${stamp}`, limit: 1 })
console.log(`  updated_from=${stamp}: HTTP ${timed.status}, total_items ${timed.json?.total_items ?? '(none)'}, ${timed.ms} ms`)
console.log(`  a filter honoring the time would return ${expectedTimed}; one using only the date, ${expectedDay}`)
if (timed.status !== 200) console.log(`  body: ${timed.text.slice(0, 200)}`)

// 5. Cost.
console.log('\n[5] Cost')
console.log(`  requests made: ${requests}`)
console.log('  rate-limit headers seen:', seenHeaders.size ? Object.fromEntries(seenHeaders) : 'none')
