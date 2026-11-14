#!/usr/bin/env node
// Spike, throwaway: can LGL tell us which gifts changed, and does a new gift
// move its constituent's updated_at?
//
// READ-ONLY. About ten GET requests to LGL; writes nothing anywhere.
// Prints counts, timings, ids and timestamps. No names, amounts or contact
// values are printed.
//
//   node spike/lgl-gifts-updated-from.mjs --env <path to .env> [--days 14]
//
// Questions:
//   1. Does /gifts/search accept q[]=updated_from=<moment>, and does it return
//      exactly the gifts whose updated_at is on or after it?
//   2. Does it honor a time of day?
//   3. Does adding or editing a gift move the constituent's own updated_at?
//      (From history: gifts newer than their constituent.)
//   4. How long does the filtered gift search take?

const BASE = 'https://api.littlegreenlight.com/api/v1'
const args = process.argv.slice(2)
const arg = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined)
const envPath = (arg('--env') ?? '.env').replace(/^~(?=\/)/, process.env.HOME)
process.loadEnvFile(envPath)
if (!process.env.LGL_API_KEY) throw new Error(`LGL_API_KEY is not set in ${envPath}`)
const auth = 'Basic ' + Buffer.from(`${process.env.LGL_API_KEY}:`).toString('base64')
const days = Number(arg('--days') ?? 14)

let requests = 0
async function getAll(path, params = {}) {
  const items = []
  let ms = 0
  let total = null
  for (let offset = 0; ; ) {
    const url = new URL(BASE + path)
    for (const [k, v] of Object.entries({ ...params, limit: 1000, offset })) url.searchParams.set(k, String(v))
    const started = performance.now()
    const res = await fetch(url, { headers: { Authorization: auth } })
    requests++
    const text = await res.text()
    ms += performance.now() - started
    if (!res.ok) return { ok: false, status: res.status, text: text.slice(0, 300), items, ms }
    const page = JSON.parse(text)
    total = page.total_items
    items.push(...page.items)
    if (page.items.length === 0 || items.length >= total) break
    offset += page.items.length
  }
  return { ok: true, status: 200, items, total, ms }
}
const t = (s) => (s ? Date.parse(s) : NaN)
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')

console.log('[1] Ground truth: all gifts and all constituents')
const gifts = await getAll('/gifts/search')
if (!gifts.ok) throw new Error(`gift pull failed: HTTP ${gifts.status} ${gifts.text}`)
const cons = await getAll('/constituents/search')
if (!cons.ok) throw new Error(`constituent pull failed: HTTP ${cons.status} ${cons.text}`)
console.log(`  ${gifts.items.length} gifts in ${(gifts.ms / 1000).toFixed(1)} s; ${cons.items.length} constituents in ${(cons.ms / 1000).toFixed(1)} s`)
const withStamp = gifts.items.filter((g) => Number.isFinite(t(g.updated_at)))
console.log(`  gifts carrying updated_at: ${withStamp.length}; created_at: ${gifts.items.filter((g) => g.created_at).length}`)

console.log('\n[2] Do gifts move their constituent\'s updated_at?')
const conStamp = new Map(cons.items.map((c) => [c.id, t(c.updated_at)]))
const newestGift = new Map()
for (const g of gifts.items) {
  const at = Math.max(t(g.updated_at) || -Infinity, t(g.created_at) || -Infinity)
  if (at > (newestGift.get(g.constituent_id) ?? -Infinity)) newestGift.set(g.constituent_id, at)
}
let newer = 0, within = 0, older = 0, orphan = 0
const examples = []
for (const [cid, at] of newestGift) {
  const c = conStamp.get(cid)
  if (c === undefined) { orphan++; continue }
  if (at > c + 60e3) { newer++; if (examples.length < 5) examples.push(`    constituent ${cid}: constituent ${iso(c)}, newest gift ${iso(at)}`) }
  else if (Math.abs(at - c) <= 60e3) within++
  else older++
}
console.log(`  constituents with gifts: ${newestGift.size} (${orphan} not in the constituent pull)`)
console.log(`  newest gift NEWER than the constituent by over a minute: ${newer}`)
console.log(`  newest gift within a minute of the constituent's stamp:  ${within}`)
console.log(`  constituent stamp later than its newest gift:            ${older}`)
if (examples.length) console.log(examples.join('\n'))
console.log(newer
  ? '  => Gifts do NOT reliably move the constituent timestamp.'
  : '  => No gift is newer than its constituent: a gift appears to move the constituent timestamp.')

console.log(`\n[3] Gift search with updated_from, by date (${days} days back)`)
const since = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10)
const byDate = await getAll('/gifts/search', { 'q[]': `updated_from=${since}` })
if (!byDate.ok) {
  console.log(`  HTTP ${byDate.status}: ${byDate.text}\n  => The filter was rejected.`)
} else {
  const got = new Set(byDate.items.map((g) => g.id))
  const expected = new Set(withStamp.filter((g) => g.updated_at.slice(0, 10) >= since).map((g) => g.id))
  const missing = [...expected].filter((id) => !got.has(id))
  const extra = [...got].filter((id) => !expected.has(id))
  console.log(`  updated_from=${since}: returned ${got.size} in ${(byDate.ms / 1000).toFixed(1)} s; expected ${expected.size} by gift updated_at`)
  console.log(`  missing: ${missing.length}; returned but not expected: ${extra.length}`)
  if (got.size === gifts.items.length) console.log('  => Returned every gift: the filter was probably ignored.')
}

console.log('\n[4] Gift search with a date and time')
// Pick a moment inside a day so that "by time" and "by date" predict different counts.
const stamps = withStamp.map((g) => t(g.updated_at)).sort((a, b) => b - a)
let pickAt = null
for (const s of stamps.slice(0, 500)) {
  const byTime = stamps.filter((x) => x >= s).length
  const byDay = withStamp.filter((g) => g.updated_at.slice(0, 10) >= iso(s).slice(0, 10)).length
  if (byTime !== byDay && byTime < 200) { pickAt = { s, byTime, byDay }; break }
}
if (!pickAt) {
  console.log('  No moment found where the two readings differ; cannot tell.')
} else {
  const timed = await getAll('/gifts/search', { 'q[]': `updated_from=${iso(pickAt.s)}` })
  console.log(`  updated_from=${iso(pickAt.s)}: HTTP ${timed.status}, returned ${timed.items.length} in ${(timed.ms / 1000).toFixed(1)} s`)
  console.log(`  honoring the time predicts ${pickAt.byTime}; date only predicts ${pickAt.byDay}`)
}
console.log(`\nrequests made: ${requests}`)
