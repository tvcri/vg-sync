// The harness's LGL client: reads and writes on the LGL trial account.
// The service's own client (src/lgl-vg/lgl.js) stays GET-only; this one is
// for the harness alone. Retries as lgl.js does: on 429 and 5xx, Retry-After
// else 30, 60, 120, 240 s, 5 attempts. fetch and sleep are injectable for tests.
//
// What the trial account showed (harness/discover.js, 2026-11-13):
// - The marker is external_constituent_id = HARNESS_MARKER. Many constituents
//   may share it; the search key is external_id (exact match, not a prefix).
//   The key external_constituent_id is refused (400) by the search.
// - GET /constituents/{id} refuses expand, so the three entry lists are read
//   one by one.

export const HARNESS_MARKER = 'vg-sync-harness'

const LGL_BASE = 'https://api.littlegreenlight.com/api/v1'
const MAX_ATTEMPTS = 5
const BACKOFF_SECONDS = [30, 60, 120, 240]
const KINDS = ['street_addresses', 'email_addresses', 'phone_numbers']
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createLglWriter({ apiKey, fetchImpl = fetch, sleep = defaultSleep, baseUrl = LGL_BASE }) {
  if (!apiKey) throw new Error('LGL_API_KEY is not set')
  const auth = 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64')

  async function request(method, path, body, params = {}) {
    const url = new URL(`${baseUrl}${path}`)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url.toString(), {
        method,
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS - 1) {
        const retryAfter = Number(res.headers.get('retry-after'))
        await sleep((retryAfter > 0 ? retryAfter : BACKOFF_SECONDS[attempt]) * 1000)
        continue
      }
      const text = await res.text()
      if (!res.ok) throw new Error(`LGL ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`)
      return text ? JSON.parse(text) : null
    }
  }

  const kind = (k) => {
    if (!KINDS.includes(k)) throw new Error(`Unknown entry kind "${k}": ${KINDS.join(' | ')}`)
    return k
  }
  const idOf = (r) => ({ id: r.id })

  return {
    request: (method, path, body) => request(method, path, body),
    createConstituent: async (body) =>
      idOf(await request('POST', '/constituents', { ...body, external_constituent_id: HARNESS_MARKER })),
    updateConstituent: (id, body) => request('PATCH', `/constituents/${id}`, body),
    deleteConstituent: (id) => request('DELETE', `/constituents/${id}`),
    addEntry: async (id, k, body) => idOf(await request('POST', `/constituents/${id}/${kind(k)}`, body)),
    updateEntry: async (id, k, entryId, body) => request('PATCH', `/${kind(k)}/${entryId}`, body),
    listEntries: async (id, k) => (await request('GET', `/constituents/${id}/${kind(k)}`, undefined, { limit: 100 })).items,
    addGift: async (id, body) => idOf(await request('POST', `/constituents/${id}/gifts`, body)),
    async getConstituent(id) {
      const c = await request('GET', `/constituents/${id}`)
      for (const k of KINDS) c[k] = (await request('GET', `/constituents/${id}/${k}`, undefined, { limit: 100 })).items
      return c
    },
    async listHarnessConstituents() {
      const r = await request('GET', '/constituents/search', undefined, { 'q[]': `external_id=${HARNESS_MARKER}`, limit: 1000 })
      if (r.items.length < r.total_items) throw new Error(`Read ${r.items.length} of ${r.total_items} harness constituents`)
      return r.items.filter((c) => c.external_constituent_id === HARNESS_MARKER)
    },
    countConstituents: async () =>
      (await request('GET', '/constituents/search', undefined, { limit: 1 })).total_items,
    HARNESS_MARKER,
  }
}
