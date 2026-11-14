#!/usr/bin/env node
// Spike, throwaway: when an address, email or phone is edited in LGL, does the
// constituent's own updated_at move, and does the updated_from search return it?
//
// READ-ONLY against LGL (two GET requests per run, a third on `check`).
// The edit itself is made by a person in the LGL web screen between the runs.
//
//   node spike/lgl-subrecord-edit.mjs baseline --env <path to .env>
//   ... someone edits one address, email or phone in LGL ...
//   node spike/lgl-subrecord-edit.mjs check --env <path to .env>
//
// The baseline goes to out/ (gitignored). It holds constituent and sub-record
// ids, timestamps and one-way hashes of the values. No names or contact values
// are stored or printed.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const BASE = 'https://api.littlegreenlight.com/api/v1'
const EXPAND = 'email_addresses,street_addresses,phone_numbers'
const SUBS = ['street_addresses', 'email_addresses', 'phone_numbers']
const FILE = new URL('../out/lgl-subrecord-baseline.json', import.meta.url).pathname

const args = process.argv.slice(2)
const mode = args[0]
if (mode !== 'baseline' && mode !== 'check') throw new Error('First argument must be "baseline" or "check"')
const envPath = (args[args.indexOf('--env') + 1] ?? '.env').replace(/^~(?=\/)/, process.env.HOME)
process.loadEnvFile(envPath)
if (!process.env.LGL_API_KEY) throw new Error(`LGL_API_KEY is not set in ${envPath}`)
const auth = 'Basic ' + Buffer.from(`${process.env.LGL_API_KEY}:`).toString('base64')

async function search(params) {
  const items = []
  for (let offset = 0; ; ) {
    const url = new URL(BASE + '/constituents/search')
    for (const [k, v] of Object.entries({ ...params, limit: 1000, offset })) url.searchParams.set(k, String(v))
    const res = await fetch(url, { headers: { Authorization: auth } })
    if (!res.ok) throw new Error(`LGL search → ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const page = await res.json()
    items.push(...page.items)
    if (page.items.length === 0 || items.length >= page.total_items) break
    offset += page.items.length
  }
  return items
}

const hash = (obj) => createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16)

// One entry per constituent: its timestamp, a hash of its own fields, and for
// each sub-record its timestamp and a hash of its values.
function summarize(constituents) {
  const out = {}
  for (const c of constituents) {
    const { updated_at, street_addresses, email_addresses, phone_numbers, ...own } = c
    const subs = {}
    for (const kind of SUBS) {
      for (const s of c[kind] ?? []) {
        const { updated_at: subUpdated, ...values } = s
        subs[`${kind}/${s.id}`] = { updated_at: subUpdated, hash: hash(values) }
      }
    }
    out[c.id] = { updated_at, hash: hash(own), subs }
  }
  return out
}

const pulledAt = new Date().toISOString()
const now = summarize(await search({ expand: EXPAND }))
console.log(`Pulled ${Object.keys(now).length} constituents at ${pulledAt}`)

if (mode === 'baseline') {
  mkdirSync(new URL('../out/', import.meta.url).pathname, { recursive: true })
  writeFileSync(FILE, JSON.stringify({ pulledAt, constituents: now }))
  console.log(`Baseline saved to ${FILE}`)
  console.log('Now edit one address, email or phone in LGL, then run "check".')
  process.exit(0)
}

const base = JSON.parse(readFileSync(FILE, 'utf8'))
console.log(`Comparing with the baseline of ${base.pulledAt}\n`)

const today = base.pulledAt.slice(0, 10)
const filtered = new Set((await search({ 'q[]': `updated_from=${today}` })).map((c) => String(c.id)))

let changed = 0
for (const [id, cur] of Object.entries(now)) {
  const old = base.constituents[id]
  if (!old) { console.log(`constituent ${id}: new since the baseline`); changed++; continue }
  const subChanges = []
  for (const [key, s] of Object.entries(cur.subs)) {
    const o = old.subs[key]
    if (!o) subChanges.push(`${key} added (updated_at ${s.updated_at})`)
    else if (o.hash !== s.hash || o.updated_at !== s.updated_at) {
      subChanges.push(`${key} ${o.hash !== s.hash ? 'values changed' : 'values same'}, ` +
        `updated_at ${o.updated_at} -> ${s.updated_at}`)
    }
  }
  for (const key of Object.keys(old.subs)) if (!cur.subs[key]) subChanges.push(`${key} removed`)
  const ownChanged = old.hash !== cur.hash
  const stampMoved = old.updated_at !== cur.updated_at
  if (!subChanges.length && !ownChanged && !stampMoved) continue
  changed++
  console.log(`constituent ${id}`)
  console.log(`  own fields: ${ownChanged ? 'changed' : 'unchanged'}`)
  for (const line of subChanges) console.log(`  ${line}`)
  console.log(`  constituent updated_at: ${stampMoved ? `MOVED ${old.updated_at} -> ${cur.updated_at}` : `DID NOT MOVE (${cur.updated_at})`}`)
  console.log(`  returned by updated_from=${today}: ${filtered.has(String(id)) ? 'YES' : 'NO'}`)
}
if (!changed) console.log('Nothing has changed since the baseline.')
