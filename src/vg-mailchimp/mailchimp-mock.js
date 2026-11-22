// A stand-in for the Mailchimp API, for rehearsals: MAILCHIMP_MOCK=<state file>.
// It is a fetchImpl behind the real client (mailchimp.js), so the request, paging and retry code a real
// run uses is the code a mock run uses; only the answers come from a file. The state is
// { list: { id, name }, members: [{ email_address, status, last_changed, merge_fields }] } and is
// written back after every write. It models only what the audience service relies on: PUT never
// changes the status of an existing member, DELETE archives. Nothing here reaches the network.
import { createMailchimpClient, subscriberHash } from './mailchimp.js'

const BASE = 'https://mock.api.mailchimp.com/3.0'

// A minimal fetch Response: what mailchimp.js reads (ok, status, statusText, headers.get, text).
const respond = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 404 ? 'Not Found' : '',
  headers: { get: () => null },
  text: async () => (body === null || body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)),
})
const notFound = (detail) => respond(404, { title: 'Resource Not Found', status: 404, detail })

// state is changed in place; persist(state) is awaited after each write; now() stamps last_changed.
export function createMockMailchimpFetch ({ state, persist, now = Date.now }) {
  const hashOf = (m) => subscriberHash(m.email_address)
  const find = (hash) => state.members.find((m) => hashOf(m) === hash)
  const written = async (status, body) => { await persist(state); return respond(status, body) }
  const count = (status) => state.members.filter((m) => m.status === status).length

  return async function mockFetch (url, init = {}) {
    const u = new URL(url)
    const method = init.method ?? 'GET'
    const p = u.searchParams
    const path = u.pathname.replace(/^\/3\.0/, '')
    const body = init.body ? JSON.parse(init.body) : {}
    let m

    if (!(m = path.match(/^\/lists\/([^/]+)(\/members(?:\/([0-9a-f]{32}))?)?$/))) return respond(404, 'mock Mailchimp: no route')
    const [, rawId, sub, hash] = m
    const id = decodeURIComponent(rawId)

    if (id !== state.list.id) return notFound(`mock Mailchimp: no list ${id}`)

    if (!sub) {
      if (method !== 'GET') return respond(404, 'mock Mailchimp: no route')
      return respond(200, {
        id: state.list.id,
        name: state.list.name,
        stats: { member_count: count('subscribed'), unsubscribe_count: count('unsubscribed'), cleaned_count: count('cleaned') },
      })
    }
    if (!hash) {
      if (method !== 'GET') return respond(404, 'mock Mailchimp: no route')
      const live = state.members.filter((x) => x.status !== 'archived')
      const offset = Number(p.get('offset') ?? 0)
      const n = Number(p.get('count') ?? 10)
      return respond(200, { members: live.slice(offset, offset + n), total_items: live.length })
    }

    const existing = find(hash)
    if (method === 'GET') return existing ? respond(200, existing) : notFound('mock Mailchimp: no such member')
    if (method === 'PUT') {
      if (!existing) {
        const created = {
          email_address: body.email_address,
          status: body.status_if_new,
          last_changed: new Date(now()).toISOString(),
          merge_fields: { ...(body.merge_fields ?? {}) },
        }
        state.members.push(created)
        return written(200, created)
      }
      if (existing.status === 'archived') return written(200, existing)
      existing.merge_fields = { ...existing.merge_fields, ...(body.merge_fields ?? {}) }
      return written(200, existing)
    }
    if (method === 'DELETE') {
      if (!existing) return notFound('mock Mailchimp: no such member')
      existing.status = 'archived'
      return written(204, null)
    }
    return respond(404, 'mock Mailchimp: no route')
  }
}

// The Mailchimp client a command uses: the mock over config.mailchimp.mock (a state file) when it is
// set, else the real API. Returns { mc, mock } (mock: the state file, or null).
export async function openMailchimp (config, { fetchImpl = fetch, sleep, readFile, writeFile, now = Date.now }) {
  const file = config.mailchimp.mock
  if (!file) return { mc: createMailchimpClient({ apiKey: config.mailchimp.apiKey, listId: config.mailchimp.listId, fetchImpl, sleep }), mock: null }
  let state
  try {
    state = JSON.parse(await readFile(file))
  } catch (e) {
    throw new Error(`MAILCHIMP_MOCK state file ${file} could not be read (${e.code ?? e.message})`)
  }
  if (!state?.list || !Array.isArray(state?.members)) throw new Error(`MAILCHIMP_MOCK state file ${file} has no list or members`)
  const mockFetch = createMockMailchimpFetch({ state, now, persist: (s) => writeFile(file, JSON.stringify(s)) })
  const mc = createMailchimpClient({ apiKey: 'mock-us0', listId: config.mailchimp.listId, fetchImpl: mockFetch, sleep, baseUrl: BASE })
  return { mc, mock: file }
}
