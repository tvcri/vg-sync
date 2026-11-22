// Mailchimp client for the audience service: auth, retries, paging. No tags are ever sent, and there
// is no permanent-delete call; archiveMember is a plain archive.

import { createHash } from 'node:crypto'

const MAX_TRIES = 4

/** Mailchimp addresses members by the MD5 of the trimmed, lowercased address. */
export const subscriberHash = (email) =>
  createHash('md5').update(email.trim().toLowerCase()).digest('hex')

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createMailchimpClient({
  apiKey, listId, fetchImpl = fetch, sleep = realSleep, timeoutMs = 60_000, baseUrl,
}) {
  const dc = apiKey.split('-').pop()
  const base = baseUrl ?? `https://${dc}.api.mailchimp.com/3.0`
  const auth = 'Basic ' + Buffer.from(`anystring:${apiKey}`).toString('base64')
  const listPath = `/lists/${encodeURIComponent(listId)}`

  // fetch with a deadline; an abort becomes a plain "timed out" error.
  async function timedFetch(url, init) {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (err) {
      if (err?.name === 'TimeoutError') {
        throw new Error(`Mailchimp ${init.method} ${new URL(url).pathname} timed out after ${timeoutMs / 1000} s`)
      }
      throw err
    }
  }

  const backoff = (attempt) => 1000 * 2 ** (attempt - 1)

  // Returns { status, body }; 404 is returned when allow404 is set. Retries 429, 5xx and network errors.
  async function request(method, path, { params = {}, body, allow404 = false } = {}) {
    const url = new URL(base + path)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
    const init = {
      method,
      headers: body === undefined
        ? { Authorization: auth }
        : { Authorization: auth, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }

    for (let attempt = 1; ; attempt++) {
      let res
      try {
        res = await timedFetch(url, init)
      } catch (err) {
        if (attempt >= MAX_TRIES) throw err
        await sleep(backoff(attempt))
        continue
      }
      if (res.ok || (allow404 && res.status === 404)) {
        const text = await res.text()
        return { status: res.status, body: text ? JSON.parse(text) : null }
      }

      const text = await res.text()
      let parsed = null
      try { parsed = JSON.parse(text) } catch { /* not JSON */ }
      const retryable = res.status === 429 || res.status >= 500
      if (retryable && attempt < MAX_TRIES) {
        const retryAfter = Number(res.headers.get('Retry-After'))
        await sleep(retryAfter > 0 ? retryAfter * 1000 : backoff(attempt))
        continue
      }
      const detail = parsed?.detail || res.statusText || text.slice(0, 200)
      const err = new Error(`Mailchimp ${method} ${path} → ${res.status}: ${parsed?.title ?? 'Request failed'}: ${detail}`)
      err.status = res.status
      err.detail = detail
      if (res.status === 401) err.final = true
      throw err
    }
  }

  return {
    async getList() {
      return (await request('GET', listPath)).body
    },

    // All pages. `fields` must keep total_items or paging cannot tell when it is done.
    async listMembers() {
      const items = []
      let total = Infinity
      while (items.length < total) {
        const { body: page } = await request('GET', `${listPath}/members`, {
          params: {
            fields: 'members.email_address,members.status,members.last_changed,members.merge_fields,total_items',
            count: 1000,
            offset: items.length,
          },
        })
        if (page?.total_items === undefined) {
          throw new Error(`Mailchimp members page returned no total_items; cannot page safely`)
        }
        total = page.total_items
        const batch = page.members ?? []
        if (batch.length === 0) break
        items.push(...batch)
      }
      return items
    },

    async getMember(hash) {
      const { status, body } = await request('GET', `${listPath}/members/${hash}`, { allow404: true })
      return status === 404 ? null : body
    },

    async putMember(hash, { email, firstName, lastName }) {
      return (await request('PUT', `${listPath}/members/${hash}`, {
        params: { skip_merge_validation: 'true' },
        body: {
          email_address: email,
          status_if_new: 'subscribed',
          merge_fields: { FNAME: firstName ?? '', LNAME: lastName ?? '' },
        },
      })).body
    },

    async archiveMember(hash) {
      await request('DELETE', `${listPath}/members/${hash}`)
    },
  }
}
