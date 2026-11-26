// Client for the Village Green API, signed in as a Keycloak service account (client-credentials grant).
// Reads persons, villages and sync state; writes submissions and holds; setup uses the privacy calls.
// fetch and the clock are injectable for tests.

const EXPIRY_MARGIN_MS = 30_000
const DEFAULT_TIMEOUT_MS = 60_000
const PRIVACY_HINT = ' (the service account has not acknowledged the privacy rules: run the setup command)'
const FORBIDDEN_HINT =
  ' (check that the service account has a role grant, a privacy acknowledgement, and the scope in VG_SCOPE)'

function httpError(message, status, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra })
}

// A refused sign-in will not get better by retrying.
function isRefusedSignIn(status, text) {
  if (status === 401) return true
  return status === 400 && /invalid_client|unauthorized_client/.test(text)
}

export function createVgClient({ apiUrl, oidcUrl, clientId, clientSecret, scope, fetchImpl = fetch, now = Date.now, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  let token = null
  let tokenExpiresAt = 0

  // fetch with a deadline; an abort becomes a plain "timed out" error. A call with its own timeout passes
  // one deadline for all its fetches (token included); otherwise each fetch gets the client's timeout.
  async function timedFetch(url, init, deadline) {
    const ms = deadline?.ms ?? timeoutMs
    try {
      return await fetchImpl(url, { ...init, signal: deadline?.signal ?? AbortSignal.timeout(ms) })
    } catch (err) {
      if (err?.name === 'TimeoutError') {
        throw new Error(`VG ${init.method} ${new URL(url).pathname} timed out after ${ms / 1000} s`)
      }
      throw err
    }
  }

  async function fetchToken(deadline) {
    const res = await timedFetch(`${oidcUrl}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope,
      }).toString(),
    }, deadline)
    if (!res.ok) {
      const text = await res.text()
      throw httpError(`Keycloak token request → ${res.status}: ${text.slice(0, 200)}`, res.status, {
        final: isRefusedSignIn(res.status, text),
      })
    }
    const body = await res.json()
    if (typeof body.access_token !== 'string' || !body.access_token) {
      throw new Error('Keycloak token response has no access_token')
    }
    if (!(Number(body.expires_in) > 0)) throw new Error('Keycloak token response has no positive expires_in')
    token = body.access_token
    tokenExpiresAt = now() + body.expires_in * 1000 - EXPIRY_MARGIN_MS
  }

  // A 403 usually means the account lacks a role grant, the privacy acknowledgement or the scope; the
  // error says so. It is not final here (start-up treats it as final for its own check). A 401 gets one
  // fresh token first.
  async function request(method, path, body, { timeoutMs: callTimeoutMs } = {}) {
    const deadline = callTimeoutMs ? { ms: callTimeoutMs, signal: AbortSignal.timeout(callTimeoutMs) } : undefined
    for (let attempt = 0; ; attempt++) {
      if (!token || now() >= tokenExpiresAt) await fetchToken(deadline)
      const res = await timedFetch(`${apiUrl}${path}`, {
        method,
        headers: body === undefined
          ? { Authorization: `Bearer ${token}` }
          : { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, deadline)
      if (res.status === 401 && attempt === 0) {
        token = null
        continue
      }
      if (!res.ok) {
        const text = await res.text()
        const hint = res.status === 403 ? (/privacy_ack_required/.test(text) ? PRIVACY_HINT : FORBIDDEN_HINT) : ''
        throw httpError(`VG ${method} ${path.split('?')[0]} → ${res.status}: ${text.slice(0, 200)}${hint}`, res.status)
      }
      if (res.status === 204) return null
      return res.json()
    }
  }

  const get = (path, opts) => request('GET', path, undefined, opts)
  // Submission ids are 19-digit strings; they stay strings and are URL-encoded.
  const submissionPath = (id) => `/friends/sync/submissions/${encodeURIComponent(String(id))}`

  return {
    // { timeoutMs } bounds the whole call (start-up uses a short one).
    whoAmI: (opts) => get('/user', opts),
    async privacyStatus() {
      return (await get('/user?projection=privacyStatus')).privacyStatus
    },
    currentPrivacyRules: () => get('/privacy/rules'),
    acknowledgePrivacy: (rulesId) => request('POST', '/privacy/acknowledgements', { rulesId }),
    listPersons: () => get('/persons?projection=detail'),
    listVillages: () => get('/villages'),
    getState: () => get('/friends/sync/state'),
    listSubmissions: () => get('/friends/sync/submissions'),
    putSubmission: (id, row) => request('PUT', submissionPath(id), row),
    deleteSubmission: (id) => request('DELETE', submissionPath(id)),
    listNameMatches: () => get('/friends/sync/name-matches'),
    putHolds: (holds) => request('PUT', '/friends/sync/holds', holds),
    listOpenHolds: () => get('/friends/sync/holds?state=open'),
  }
}
