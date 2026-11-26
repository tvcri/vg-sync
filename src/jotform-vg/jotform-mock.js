// A stand-in for the JotForm API, for rehearsals: JOTFORM_MOCK=<state file>.
// It is a fetchImpl behind the real reader (jotform.js), so request and paging code is the code a real
// run uses; only the answers come from a file. The state is
// { form?: { status }, submissions: [{ id, created_at, updated_at, status, answers }] }.
// It is read-only, like the reader; persist is accepted for symmetry and never called. Nothing here
// reaches the network.
import { createJotformReader } from './jotform.js'

const BASE = 'https://mock.api.jotform.com'

const respond = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 404 ? 'Not Found' : '',
  headers: { get: () => null },
  text: async () => JSON.stringify(body),
  json: async () => body,
})

export function createMockJotformFetch({ state }) {
  return async function mockFetch(url, init = {}) {
    const u = new URL(url)
    const method = init.method ?? 'GET'
    const m = u.pathname.match(/^\/form\/([^/]+)(\/submissions)?$/)
    if (method !== 'GET' || !m) return respond(404, { responseCode: 404, message: 'mock JotForm: no route' })

    if (!m[2]) return respond(200, { responseCode: 200, content: { id: decodeURIComponent(m[1]), title: 'Mock form', status: 'ENABLED', ...(state.form ?? {}) } })

    let rows = [...state.submissions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const filter = u.searchParams.get('filter')
    if (filter) {
      for (const [key, after] of Object.entries(JSON.parse(filter))) {
        const [field, op] = key.split(':')
        if (op !== 'gt' || !['created_at', 'updated_at'].includes(field)) {
          return respond(400, { responseCode: 400, message: `mock JotForm: unsupported filter ${key}` })
        }
        rows = rows.filter((s) => s[field] != null && s[field] > after)
      }
    }
    const offset = Number(u.searchParams.get('offset') ?? 0)
    const limit = Number(u.searchParams.get('limit') ?? 20)
    return respond(200, { responseCode: 200, content: rows.slice(offset, offset + limit) })
  }
}

// The reader a command uses: over the mock state file when config.jotform.mock is set, else the real API.
export async function openJotform(config, { fetchImpl = fetch, readFile, writeFile } = {}) {
  const file = config.jotform.mock
  if (!file) return createJotformReader({ apiKey: config.jotform.apiKey, formId: config.jotform.formId, fetchImpl })
  let state
  try {
    state = JSON.parse(await readFile(file))
  } catch (e) {
    throw new Error(`JOTFORM_MOCK state file ${file} could not be read (${e.code ?? e.message})`)
  }
  if (!Array.isArray(state?.submissions)) throw new Error(`JOTFORM_MOCK state file ${file} has no submissions`)
  const mockFetch = createMockJotformFetch({ state, persist: (s) => writeFile(file, JSON.stringify(s)) })
  return createJotformReader({ apiKey: 'mock', formId: config.jotform.formId, fetchImpl: mockFetch, baseUrl: BASE })
}
