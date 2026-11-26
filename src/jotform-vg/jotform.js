// JotForm reader for the friendly calls and visits sync. GET only: nothing here writes to JotForm.
// Times (created_at, updated_at) are Eastern wall-clock strings, compared and passed as given.
// Submission ids are 19-digit strings; they are never turned into numbers.

const BASE = 'https://api.jotform.com'
const PAGE = 1000
const FIELDS = ['created_at', 'updated_at']

export function createJotformReader({ apiKey, formId, fetchImpl = fetch, timeoutMs = 60_000, baseUrl = BASE }) {
  const formPath = `/form/${encodeURIComponent(formId)}`

  // GET with a deadline; returns the body's content. Non-2xx and a body responseCode other than 200 throw.
  async function get(path, params = {}) {
    const url = new URL(baseUrl + path)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
    let res
    try {
      res = await fetchImpl(url, { method: 'GET', headers: { APIKEY: apiKey }, signal: AbortSignal.timeout(timeoutMs) })
    } catch (err) {
      if (err?.name === 'TimeoutError') throw new Error(`JotForm GET ${path} timed out after ${timeoutMs / 1000} s`)
      throw err
    }
    const text = await res.text()
    let body = null
    try { body = JSON.parse(text) } catch { /* not JSON */ }
    if (!res.ok) {
      const err = new Error(`JotForm GET ${path} → ${res.status}: ${body?.message ?? res.statusText ?? text.slice(0, 200)}`)
      err.status = res.status
      // 401 (bad key) and 403 (no access) mean the key is unusable: final, not worth retrying.
      if (res.status === 401 || res.status === 403) err.final = true
      throw err
    }
    if (body?.responseCode !== 200) {
      throw new Error(`JotForm GET ${path} returned responseCode ${body?.responseCode}: ${body?.message ?? 'no message'}`)
    }
    return body.content
  }

  async function listPages(filter) {
    const items = []
    for (let offset = 0; ; offset += PAGE) {
      const params = { limit: PAGE, offset, orderby: 'id' }
      if (filter) params.filter = JSON.stringify(filter)
      const page = await get(`${formPath}/submissions`, params)
      if (!Array.isArray(page)) throw new Error('JotForm submissions response had no content list')
      items.push(...page)
      if (page.length < PAGE) return items
    }
  }

  return {
    async listSince(field, after) {
      if (!FIELDS.includes(field)) throw new Error(`listSince: field must be one of ${FIELDS.join(', ')}`)
      return listPages({ [`${field}:gt`]: after })
    },
    listAll: () => listPages(null),
    // The form's status (e.g. 'ENABLED'), for the start-up check.
    async ping() {
      return { status: (await get(formPath)).status }
    },
  }
}
