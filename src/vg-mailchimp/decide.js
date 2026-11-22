// Pure decisions for the VG -> Mailchimp executable. No I/O.

const DAY_MS = 86_400_000

export function selectArchives(members, nowMs, afterDays) {
  const cutoff = nowMs - afterDays * DAY_MS
  return members.filter((m) => {
    if (m.status !== 'unsubscribed') return false
    const t = Date.parse(m.last_changed)
    return Number.isFinite(t) && t <= cutoff // unparseable: fail closed
  })
}

// Fail closed: anything but absent or subscribed is left alone.
export function classify(candidate, status) {
  if (status === null || status === undefined) return { action: 'add', reason: undefined }
  if (status === 'subscribed') return { action: 'present', reason: undefined }
  return { action: 'skip', reason: status }
}

export function billable(stats) {
  return stats.member_count + stats.unsubscribe_count
}

export function limitAdds(adds, { billable: used, planLimit, limitMargin }) {
  const room = Math.max(0, planLimit - limitMargin - used)
  return { add: adds.slice(0, room), held: adds.slice(room) }
}

export function capExceeded(count, max) {
  return max !== null && max !== undefined && count > max
}

const NAMED = ['no-email', 'invalid-email', 'unsubscribed', 'cleaned', 'archived', 'limit', 'cap']

export function summaryLine(s) {
  const left = s.leftOut || {}
  let total = 0
  let other = 0
  for (const [k, n] of Object.entries(left)) {
    total += n
    if (!NAMED.includes(k)) other += n
  }
  const parts = NAMED.map((k) => `${k}=${left[k] || 0}`)
  parts.push(`other=${other}`)
  const onOff = (b) => (b ? 'on' : 'off')
  return `MAILCHIMP OK adds=${s.adds} archives=${s.archives} subscribed=${s.subscribed} left-out=${total} (${parts.join(' ')}) billable=${s.billable}/${s.planLimit} writes=add:${onOff(s.writeAdd)},archive:${onOff(s.writeArchive)}`
}
