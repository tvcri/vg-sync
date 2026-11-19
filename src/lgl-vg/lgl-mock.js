// A stand-in for the LGL API, for rehearsals on production data: LGL_MOCK=<state file>.
// It is a fetchImpl behind the real client (lgl.js), so the request, paging and retry code a real run
// uses is the code a mock run uses; only the answers come from a file. The state starts as a saved
// pull (`report --save-snapshot` writes { pulledAt, constituents, gifts }) and is written back after
// every write, so separate runs see each other's writes. It is not a model of LGL: no address
// verification, dedup, validation, refusals or rate limits. Nothing here reaches the network.
import { createLglClient } from './lgl.js'
import { lglDefaultNames } from './fields.js'

const BASE = 'https://api.littlegreenlight.com/api/v1'
const KINDS = ['street_addresses', 'email_addresses', 'phone_numbers']

// A minimal fetch Response: what lgl.js reads (ok, status, headers.get, json, text).
const respond = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => JSON.parse(JSON.stringify(body)),
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
})
const page = (items, params) => {
  const offset = Number(params.get('offset') ?? 0)
  const limit = Number(params.get('limit') ?? 25)
  return { items: items.slice(offset, offset + limit), total_items: items.length, offset, limit }
}
// The search filter the sync sends: q[]=updated_from=<ISO time or date>.
const updatedFrom = (params) => {
  const q = params.getAll('q[]').find((x) => x.startsWith('updated_from='))
  return q ? Date.parse(q.slice('updated_from='.length)) : null
}
const since = (from) => (x) => from === null || Date.parse(x.updated_at) >= from

// state: { constituents, gifts } (changed in place); persist(state) is awaited after each write;
// now() gives the time a write stamps on updated_at.
export function createMockLglFetch ({ state, persist, now = Date.now }) {
  const byId = (id) => state.constituents.find((c) => String(c.id) === String(id))
  let nextId = 1 + Math.max(0, ...state.constituents.flatMap((c) => KINDS.flatMap((k) => (c[k] ?? []).map((e) => Number(e.id) || 0))))
  const findEntry = (kind, entryId) => {
    for (const c of state.constituents) {
      const e = (c[kind] ?? []).find((x) => String(x.id) === String(entryId))
      if (e) return { c, e }
    }
    return null
  }
  const stamp = (c) => { c.updated_at = new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z') }
  // LGL has one preferred entry of a kind per constituent.
  const takeMark = (c, kind, e) => { if (e.is_preferred) for (const x of c[kind]) if (x !== e) x.is_preferred = false }
  const written = async (status, body) => { await persist(state); return respond(status, body) }

  return async function mockFetch (url, init = {}) {
    if (!String(url).startsWith(BASE + '/')) throw new Error(`mock LGL: refusing a request outside LGL: ${url}`)
    const u = new URL(url)
    const path = u.pathname.slice(new URL(BASE).pathname.length)
    const method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(init.body) : {}
    const p = u.searchParams
    let m

    if (method === 'GET') {
      if (path === '/constituents/search') return respond(200, page(state.constituents.filter(since(updatedFrom(p))), p))
      if (path === '/gifts/search') return respond(200, page(state.gifts.filter(since(updatedFrom(p))), p))
      if (path === '/constituents.json') return respond(200, page(state.constituents, p))
      if ((m = path.match(/^\/constituents\/(\d+)\.json$/))) {
        const c = byId(m[1])
        return c ? respond(200, c) : respond(404, 'Not found')
      }
      if ((m = path.match(/^\/constituents\/(\d+)\/gifts\.json$/))) {
        if (!byId(m[1])) return respond(404, 'Not found')
        return respond(200, page(state.gifts.filter((g) => String(g.constituent_id) === m[1]), p))
      }
      if ((m = path.match(/^\/constituents\/(\d+)\/(street_addresses|email_addresses|phone_numbers)$/))) {
        const c = byId(m[1])
        return c ? respond(200, page(c[m[2]] ?? [], p)) : respond(404, 'Not found')
      }
    }
    if (method === 'PATCH' && (m = path.match(/^\/constituents\/(\d+)$/))) {
      const c = byId(m[1])
      if (!c) return respond(404, 'Not found')
      Object.assign(c, body)
      // LGL builds an empty addressee and salutation again from the name
      const d = lglDefaultNames(c)
      if (body.addressee === '') c.addressee = d.addressee
      if (body.salutation === '') c.salutation = d.salutation
      stamp(c)
      return written(200, c)
    }
    if (method === 'POST' && (m = path.match(/^\/constituents\/(\d+)\/(street_addresses|email_addresses|phone_numbers)$/))) {
      const [, id, kind] = m
      const c = byId(id)
      if (!c) return respond(404, 'Not found')
      c[kind] = c[kind] ?? []
      const first = !c[kind].some((x) => !x.not_current)
      const e = { ...body, id: nextId++, parent_id: c.id, not_current: false, is_preferred: Boolean(body.is_preferred) || first }
      if (kind === 'phone_numbers') e.normalized_number = String(body.number ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
      if (kind === 'street_addresses') e.zip5 = String(body.postal_code ?? '').slice(0, 5)
      e.created_at = e.updated_at = new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z')
      c[kind].push(e)
      takeMark(c, kind, e)
      stamp(c)
      return written(200, e)
    }
    if (method === 'PATCH' && (m = path.match(/^\/(street_addresses|email_addresses|phone_numbers)\/(\d+)$/))) {
      const found = findEntry(m[1], m[2])
      if (!found) return respond(404, 'Not found')
      Object.assign(found.e, body)
      takeMark(found.c, m[1], found.e)
      stamp(found.c)
      return written(200, found.e)
    }
    return respond(404, `mock LGL: no route for ${method} ${path}`)
  }
}

// The LGL client a command uses: the mock over config.lgl.mock (a state file) when it is set, else the
// real API. Returns { lgl, mock } (mock: the state file, or null). A missing or unreadable state
// file refuses to start.
export async function openLgl (config, { fetchImpl = fetch, sleep, readFile, writeFile, now = Date.now }) {
  const file = config.lgl.mock
  if (!file) return { lgl: createLglClient({ apiKey: config.lgl.apiKey, fetchImpl, sleep }), mock: null }
  let state
  try {
    state = JSON.parse(await readFile(file))
  } catch (e) {
    throw new Error(`LGL_MOCK state file ${file} could not be read (${e.code ?? e.message}); start one by copying a saved pull (report --save-snapshot)`)
  }
  if (!Array.isArray(state?.constituents) || !Array.isArray(state?.gifts)) throw new Error(`LGL_MOCK state file ${file} has no constituents or gifts`)
  const mockFetch = createMockLglFetch({ state, now, persist: (s) => writeFile(file, JSON.stringify(s)) })
  return { lgl: createLglClient({ apiKey: 'mock', fetchImpl: mockFetch, sleep }), mock: file }
}
