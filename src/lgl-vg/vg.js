// Client for the Village Green API, signed in as a Keycloak service account
// (client-credentials grant). Reads the roster; creates people and writes person and donor
// changes (a donor row can be removed); calls the town lookup; and reads and writes the sync
// tables (field memory, holds, runs). Batch calls are split into chunks of 500, the API's limit.
// fetch and the clock are injectable for tests.

const EXPIRY_MARGIN_MS = 30_000
const BATCH = 500
const FORBIDDEN_HINT =
  ' (check that the service account has a role grant, a privacy acknowledgement, and the scope in VG_SCOPE)'

function httpError(message, status) {
  return Object.assign(new Error(message), { status })
}

export function createVgClient({ apiUrl, oidcUrl, clientId, clientSecret, scope, fetchImpl = fetch, now = Date.now }) {
  let token = null
  let tokenExpiresAt = 0

  async function fetchToken() {
    const res = await fetchImpl(`${oidcUrl}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope,
      }).toString(),
    })
    if (!res.ok) {
      const text = await res.text()
      throw httpError(`Keycloak token request → ${res.status}: ${text.slice(0, 200)}`, res.status)
    }
    const body = await res.json()
    token = body.access_token
    tokenExpiresAt = now() + body.expires_in * 1000 - EXPIRY_MARGIN_MS
  }

  async function request(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      if (!token || now() >= tokenExpiresAt) await fetchToken()
      const res = await fetchImpl(`${apiUrl}${path}`, {
        method,
        headers: body === undefined
          ? { Authorization: `Bearer ${token}` }
          : { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (res.status === 401 && attempt === 0) {
        token = null
        continue
      }
      if (!res.ok) {
        const text = await res.text()
        const hint = res.status === 403 ? FORBIDDEN_HINT : ''
        throw httpError(`VG ${method} ${path.split('?')[0]} → ${res.status}: ${text.slice(0, 200)}${hint}`, res.status)
      }
      if (res.status === 204) return null // DELETE answers with no body
      return res.json()
    }
  }

  const get = (path) => request('GET', path)

  async function inBatches(method, path, items) {
    const out = []
    for (let i = 0; i < items.length; i += BATCH) {
      out.push(await request(method, path, items.slice(i, i + BATCH)))
    }
    return out
  }
  const sum = (results, key) => results.reduce((n, r) => n + r[key], 0)

  return {
    whoAmI: () => get('/user'),
    async privacyStatus() {
      return (await get('/user?projection=privacyStatus')).privacyStatus
    },
    currentPrivacyRules: () => get('/privacy/rules'),
    acknowledgePrivacy: (rulesId) => request('POST', '/privacy/acknowledgements', { rulesId }),
    async listPersons() {
      const persons = await get('/persons?projection=detail')
      if (persons.length > 0 && !persons.some((p) => Object.hasOwn(p, 'donor'))) {
        throw new Error('The service account cannot read donors (donor:read is missing)')
      }
      return persons
    },
    // The persons linked to one LGL constituent, in listPersons' shape (detail, phone, donor).
    // The single-person read has no detail projection, so the pre-write re-read uses this.
    getLinkedPersons(lglConstituentId) {
      const q = new URLSearchParams({ lglConstituentId: String(lglConstituentId), projection: 'detail' })
      return get(`/persons?${q}`)
    },
    createPerson: (body) => request('POST', '/persons', body),
    patchPerson: (personId, body) => request('PATCH', `/persons/${personId}`, body),
    putDonor: (personId, { lglConstituentId, lastGiftDate }) =>
      request('PUT', `/persons/${personId}/donor`, { lglConstituentId, lastGiftDate }),
    deleteDonor: (personId) => request('DELETE', `/persons/${personId}/donor`),
    geocodeTown: ({ street, city, state, zip }) => request('POST', '/op/geocode/town', { street, city, state, zip }),
    getSyncFields: () => get('/sync/fields'),
    async putSyncFields(rows) {
      return sum(await inBatches('PUT', '/sync/fields', rows), 'upserted')
    },
    getSyncHolds(states) {
      const q = new URLSearchParams(states.map((s) => ['state', s]))
      return get(`/sync/holds?${q}`)
    },
    async createSyncHolds(items) {
      return (await inBatches('POST', '/sync/holds', items)).flat()
    },
    async patchSyncHolds(items) {
      return sum(await inBatches('PATCH', '/sync/holds', items), 'updated')
    },
    startRun: ({ kind, switches, imageRevision, policyHash }) =>
      request('POST', '/sync/runs', { kind, switches, imageRevision, policyHash }),
    finishRun: (runId, { result, counts, lglCursor, vgCursor, error }) =>
      request('PATCH', `/sync/runs/${runId}`, { result, counts, lglCursor, vgCursor, error }),
    async lastFullRun() {
      const runs = await get('/sync/runs?kind=full&limit=20')
      return runs.find((r) => r.result === 'ok') ?? null
    },
  }
}
