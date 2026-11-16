#!/usr/bin/env node
// One-off, kept for the next trial account: how LGL builds a constituent's
// addressee and salutation, for the sync design's lgl-addressee setting.
//
//   node harness/discover-names.js --env .env.harness            (reads only; writes are printed)
//   node harness/discover-names.js --env .env.harness --write    (writes to the trial account)
//
// The account's Constituent Names settings (the same on trial and production,
// 2026-11-16): salutation Informal, addressee Formal, "and" style "John and Jane
// Smith", prefix and suffix fields off, spouse in salutation off.
//
// It settles, and prints:
//   - what a new constituent's addressee and salutation are, for name shapes:
//     first and last; with a middle name; with a nickname; with a suffix; with
//     a prefix sent through the API; a couple's "Pat and Lee" as the first name;
//   - whether a PATCH of the first name changes them (2026-11-11: it did not);
//   - whether a PATCH that clears them makes LGL build them again;
//   - whether a PATCH that sets them stores what was sent.
//
// Before any write it checks that the key reaches the trial account, as
// harness/discover.js does. Every constituent it creates is deleted before it
// exits, each re-read first. At most 95 requests.

import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

const BASE = 'https://api.littlegreenlight.com/api/v1'
const SENTINEL = { first_name: 'Zztrial', last_name: 'Sentinel' }
const MAX_CONSTITUENTS = 200
const MAX_REQUESTS = 95
const PROBE_LAST = 'Zzharness'

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const envAt = args.indexOf('--env')
if (envAt >= 0 && !args[envAt + 1]) throw new Error('--env needs a file')
const envFile = envAt >= 0 ? args[envAt + 1] : '.env.harness'
const env = parseEnv(readFileSync(envFile, 'utf8'))
if (!env.LGL_API_KEY) throw new Error(`LGL_API_KEY is not set in ${envFile}`)
const auth = 'Basic ' + Buffer.from(`${env.LGL_API_KEY}:`).toString('base64')

let requests = 0
let fakeId = 0
async function call(method, path, body, params = {}) {
  if (method !== 'GET' && !WRITE) {
    console.log(`   DRY ${method} ${path} ${body === undefined ? '' : JSON.stringify(body)}`)
    return { status: 0, json: { id: `dry${++fakeId}` }, text: '(dry run)' }
  }
  if (requests >= MAX_REQUESTS) throw new Error(`STOP: request budget of ${MAX_REQUESTS} spent.`)
  const url = new URL(BASE + path)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  const res = await fetch(url, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  requests++
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  if (res.status === 429) throw new Error(`Rate limited (Retry-After ${res.headers.get('retry-after')}). Stopping.`)
  return { status: res.status, json, text }
}
const ok = (r) => r.status >= 200 && r.status < 300
const say = (label, r) =>
  console.log(`   ${label} -> HTTP ${r.status}${ok(r) ? '' : `: ${r.text.slice(0, 300)}`}`)

async function guard() {
  const head = await call('GET', '/constituents/search', undefined, { limit: 1 })
  if (head.status !== 200) throw new Error(`Count request failed: HTTP ${head.status} ${head.text.slice(0, 200)}`)
  const total = head.json?.total_items
  if (!Number.isInteger(total)) throw new Error('Count request returned no total_items.')
  if (total >= MAX_CONSTITUENTS) {
    throw new Error(`STOP: ${total} constituents; the trial account has fewer than ${MAX_CONSTITUENTS}. This key may reach production.`)
  }
  const all = await call('GET', '/constituents/search', undefined, { limit: 1000 })
  const items = all.json?.items ?? []
  if (items.length !== total) throw new Error(`Read ${items.length} of ${total} constituents.`)
  const hits = items.filter((c) => c.first_name === SENTINEL.first_name && c.last_name === SENTINEL.last_name)
  if (hits.length !== 1) {
    throw new Error(`STOP: expected one constituent named ${SENTINEL.first_name} ${SENTINEL.last_name}, found ${hits.length}.`)
  }
  console.log(`GUARD PASSED: ${total} constituents, sentinel present.`)
  return items
}

const created = []
async function createProbe(label, body) {
  const full = { last_name: PROBE_LAST, ...body }
  const r = await call('POST', '/constituents', full)
  say(`${label}: POST /constituents ${JSON.stringify(full)}`, r)
  if (ok(r) && r.json?.id) created.push(r.json.id)
  return r.json?.id
}
async function cleanup() {
  for (const id of created) {
    const g = await call('GET', `/constituents/${id}`)
    if (g.status !== 200 || g.json?.id !== id || g.json?.last_name !== PROBE_LAST) {
      console.log(`   NOT deleting ${id}: it is not a probe record (HTTP ${g.status}).`)
      continue
    }
    const d = await call('DELETE', `/constituents/${id}`)
    say(`DELETE /constituents/${id}`, d)
  }
}

const NAME_KEYS = /name|salut|addressee|prefix|suffix/i
let shownKeys = false
async function show(label, id) {
  if (!WRITE) return
  const r = await call('GET', `/constituents/${id}`)
  if (!ok(r)) return say(`GET ${label}`, r)
  if (!shownKeys) {
    console.log(`   name-like keys on a constituent: ${Object.keys(r.json).filter((k) => NAME_KEYS.test(k)).join(', ')}`)
    shownKeys = true
  }
  const c = r.json
  const parts = ['prefix', 'first_name', 'middle_name', 'nick_name', 'last_name', 'suffix']
    .filter((k) => c[k]).map((k) => `${k}=${JSON.stringify(c[k])}`).join(' ')
  console.log(`   ${label}: ${parts}\n      addressee=${JSON.stringify(c.addressee)} salutation=${JSON.stringify(c.salutation)}`)
}
async function patch(label, id, body) {
  const r = await call('PATCH', `/constituents/${id}`, body)
  say(`${label}: PATCH ${JSON.stringify(body)}`, r)
}

console.log(WRITE ? 'WRITING to the trial account.' : 'Dry run: writes are printed, not sent. Add --write to send.')
const items = await guard()
const leftovers = items.filter((c) => c.last_name === PROBE_LAST)
if (leftovers.length) throw new Error(`STOP: ${leftovers.length} ${PROBE_LAST} record(s) left from an earlier run; delete them first.`)

try {
  console.log('\n== New constituents: what LGL builds')
  const shapes = [
    ['plain', { first_name: 'Jane' }],
    ['middle', { first_name: 'Jane', middle_name: 'Quinn' }],
    ['nickname', { first_name: 'Jane', nick_name: 'Jay' }],
    ['suffix', { first_name: 'John', suffix: 'Jr.' }],
    ['prefix', { first_name: 'Jane', prefix: 'Dr.' }],
    ['couple', { first_name: 'Pat and Lee' }],
  ]
  for (const [label, body] of shapes) await show(label, await createProbe(label, body))

  console.log('\n== Edits to an existing constituent')
  const a = await createProbe('rename', { first_name: 'Jane' })
  await patch('rename', a, { first_name: 'Janet' })
  await show('after first-name PATCH', a)

  const b = await createProbe('clear', { first_name: 'Jane' })
  await patch('clear to empty', b, { first_name: 'Janet', addressee: '', salutation: '' })
  await show('after clearing to ""', b)
  await patch('clear to null', b, { addressee: null, salutation: null })
  await show('after clearing to null', b)

  const c = await createProbe('set', { first_name: 'Jane' })
  await patch('set', c, { first_name: 'Janet', addressee: `Janet ${PROBE_LAST}`, salutation: 'Janet' })
  await show('after setting both', c)
} finally {
  console.log('\n== Cleanup')
  await cleanup()
  console.log(`\n${requests} requests.`)
}
