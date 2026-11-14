// Read-only client for the LGL REST API v1. No caching: every run sees live data.
// Ported from vg-utils/lgl-import/src/lgl.js on 2026-11-11, with a longer retry policy.
// fetch and sleep are injectable for tests. Only GET is issued.

const LGL_BASE = 'https://api.littlegreenlight.com/api/v1'
const PAGE = 1000
const MAX_ATTEMPTS = 5
const BACKOFF_SECONDS = [30, 60, 120, 240]
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createLglClient({ apiKey, fetchImpl = fetch, sleep = defaultSleep, baseUrl = LGL_BASE }) {
  if (!apiKey) throw new Error('LGL_API_KEY is not set')
  const auth = 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64')

  async function get(path, params = {}) {
    const url = new URL(`${baseUrl}${path}`)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))

    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
      })
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS - 1) {
        const retryAfter = Number(res.headers.get('retry-after'))
        await sleep((retryAfter > 0 ? retryAfter : BACKOFF_SECONDS[attempt]) * 1000)
        continue
      }
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`LGL GET ${path} → ${res.status}: ${text.slice(0, 200)}`)
      }
      return res.json()
    }
  }

  async function fetchAll(path, params = {}) {
    const items = []
    let total = 0
    for (let offset = 0; ; ) {
      const page = await get(path, { ...params, limit: PAGE, offset })
      total = page.total_items
      items.push(...page.items)
      if (page.items.length === 0 || items.length >= total) break
      offset += page.items.length
    }
    if (items.length !== total) {
      throw new Error(`Incomplete read of ${path}: got ${items.length} of ${total}`)
    }
    return items
  }

  return {
    pullConstituents: () =>
      fetchAll('/constituents/search', { expand: 'email_addresses,street_addresses,phone_numbers' }),
    pullGifts: () => fetchAll('/gifts/search'),
  }
}
