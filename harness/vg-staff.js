// The harness's VG client: makes the edits staff would make in the app, signed
// in as its own Keycloak service account (vg-sync-harness, client credentials).
// The token logic is copied from src/lgl-vg/vg.js (src never imports harness
// code, and the harness keeps its own copy rather than reaching into src's
// internals). fetch and the clock are injectable for tests.

const EXPIRY_MARGIN_MS = 30_000

function httpError(message, status) {
  return Object.assign(new Error(message), { status })
}

export function createVgStaff({ apiUrl, oidcUrl, clientId, clientSecret, scope = 'vg', fetchImpl = fetch, now = Date.now }) {
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
      const text = await res.text()
      if (!res.ok) {
        throw httpError(`VG staff ${method} ${path.split('?')[0]} → ${res.status}: ${text.slice(0, 200)}`, res.status)
      }
      return text ? JSON.parse(text) : null // DELETE answers 204 with no body
    }
  }

  const get = (path) => request('GET', path)

  return {
    createPerson: (body) => request('POST', '/persons', body),
    patchPerson: (personId, body) => request('PATCH', `/persons/${personId}`, body),
    putDonor: (personId, { lglConstituentId, lastGiftDate }) =>
      request('PUT', `/persons/${personId}/donor`, { lglConstituentId: String(lglConstituentId), lastGiftDate }),
    deleteDonor: (personId) => request('DELETE', `/persons/${personId}/donor`),
    getPersons(lglConstituentId) {
      const q = new URLSearchParams({ lglConstituentId: String(lglConstituentId), projection: 'detail' })
      return get(`/persons?${q}`)
    },
    // The single-person read has no detail projection, so this reads the list.
    async getPerson(personId) {
      const persons = await get('/persons?projection=detail')
      return persons.find((p) => String(p.personId) === String(personId)) ?? null
    },
    listHolds(states = ['open']) {
      const q = new URLSearchParams(states.map((s) => ['state', s]))
      return get(`/sync/holds?${q}`)
    },
    // The LGL write log: the flapping scenario seeds written rows; expect.lglLog reads a person's rows.
    appendSyncLog: (rows) => request('POST', '/sync/log', rows),
    getSyncLog({ personId, outcome, limit = 100 }) {
      const q = new URLSearchParams({ personId: String(personId), outcome, limit: String(limit) })
      return get(`/sync/log?${q}`)
    },
    dismissHold: (holdId, { dismissalKind, note } = {}) =>
      request('POST', `/sync/holds/${holdId}/dismissal`, { dismissalKind, ...(note === undefined ? {} : { note }) }),
    // Acknowledges the current privacy rules if the account owes it.
    async acknowledgePrivacy() {
      const { privacyStatus } = await get('/user?projection=privacyStatus')
      if (privacyStatus?.needsAck !== true) return { acknowledged: false }
      const rules = await get('/privacy/rules')
      await request('POST', '/privacy/acknowledgements', { rulesId: rules.id })
      return { acknowledged: true }
    },
  }
}
