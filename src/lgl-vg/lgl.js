// Read-only client for the LGL REST API v1. No caching: every run sees live data.
// Ported from vg-utils/lgl-import/src/lgl.js on 2026-11-11, with a longer retry policy.
// fetch and sleep are injectable for tests. Only GET is issued.

const LGL_BASE = 'https://api.littlegreenlight.com/api/v1'
const PAGE = 1000
const MAX_ATTEMPTS = 5
const BACKOFF_SECONDS = [30, 60, 120, 240]
const DEFAULT_TIMEOUT_MS = 120_000
// The probe makes one attempt with a short timeout. Start-up passes its own timeout (from its shared
// budget) and does its own retries; this is only the default.
export const PROBE_TIMEOUT_MS = 15_000
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createLglClient({ apiKey, fetchImpl = fetch, sleep = defaultSleep, baseUrl = LGL_BASE, timeoutMs = DEFAULT_TIMEOUT_MS, probeTimeoutMs = PROBE_TIMEOUT_MS }) {
  if (!apiKey) throw new Error('LGL_API_KEY is not set')
  const auth = 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64')

  // A 401 means the API key is wrong or revoked: retrying will not help, so the error is final. A 403 is
  // not: LGL is not known to answer a bad key with one, so it is left to the caller's retries.
  async function get(path, params = {}, { attempts = MAX_ATTEMPTS, timeoutMs: callTimeoutMs = timeoutMs } = {}) {
    const url = new URL(`${baseUrl}${path}`)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))

    for (let attempt = 0; ; attempt++) {
      let res
      try {
        res = await fetchImpl(url.toString(), {
          method: 'GET',
          headers: { Authorization: auth, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(callTimeoutMs),
        })
      } catch (err) {
        // A network failure or a timeout is retried like a 429 or a 5xx.
        if (attempt < attempts - 1) {
          await sleep(BACKOFF_SECONDS[attempt] * 1000)
          continue
        }
        if (err?.name === 'TimeoutError') throw new Error(`LGL GET ${path} timed out after ${callTimeoutMs / 1000} s`)
        throw err
      }
      if ((res.status === 429 || res.status >= 500) && attempt < attempts - 1) {
        const retryAfter = Number(res.headers.get('retry-after'))
        await sleep((retryAfter > 0 ? retryAfter : BACKOFF_SECONDS[attempt]) * 1000)
        continue
      }
      if (!res.ok) {
        const text = await res.text()
        throw Object.assign(new Error(`LGL GET ${path} → ${res.status}: ${text.slice(0, 200)}`), {
          status: res.status,
          final: res.status === 401,
        })
      }
      return res.json()
    }
  }

  async function fetchAll(path, params = {}, opts = {}) {
    const items = []
    let total = 0
    for (let offset = 0; ; ) {
      const page = await get(path, { ...params, limit: PAGE, offset }, opts)
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
    // Reads for the change checks. { attempts } bounds the retries of each request; a final non-OK
    // answer throws with .status. The constituent read takes no query string (expand= answers 403).
    getConstituent: (id, { attempts } = {}) => get(`/constituents/${id}.json`, {}, { attempts }),
    constituentGifts: (id, { attempts } = {}) => fetchAll(`/constituents/${id}/gifts.json`, {}, { attempts }),
    constituentsSince: (iso, { attempts } = {}) =>
      fetchAll('/constituents/search', { 'q[]': `updated_from=${iso}`, expand: 'email_addresses,street_addresses,phone_numbers' }, { attempts }),
    giftsSince: (date, { attempts } = {}) => fetchAll('/gifts/search', { 'q[]': `updated_from=${date}` }, { attempts }),
    // One cheap read, to show LGL answers and the API key still works: one attempt, a short timeout.
    // A 429 (LGL's rate-limit pause) counts as reached: LGL answered, and the key was not refused.
    // Resolves { rateLimited }; throws on any other failure.
    async probe({ timeoutMs: probeTimeout = probeTimeoutMs } = {}) {
      try {
        await get('/constituents.json', { limit: 1 }, { attempts: 1, timeoutMs: probeTimeout })
      } catch (err) {
        if (err?.status === 429) return { rateLimited: true }
        throw err
      }
      return { rateLimited: false }
    },
  }
}
