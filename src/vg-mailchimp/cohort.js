import { subscriberHash } from './mailchimp.js'

export function inCohort (person) {
  return !person.deceased &&
    (person.memberStatus === 'Active' || person.volunteerStatus === 'Active' || person.donor != null)
}

export function isValidEmail (email) {
  if (typeof email !== 'string' || /\s/.test(email)) return false
  const parts = email.split('@')
  if (parts.length !== 2 || parts[0] === '') return false
  const domain = parts[1]
  const dot = domain.indexOf('.')
  return dot > 0 && !domain.endsWith('.') && domain.length > 0
}

const byId = (a, b) => Number(a) - Number(b)

export function buildCandidates (persons) {
  const cohort = persons.filter(inCohort)
  const groups = new Map() // normalized email -> persons
  const leftOut = []
  for (const person of cohort) {
    const email = typeof person.email === 'string' ? person.email.trim().toLowerCase() : ''
    if (email === '') {
      leftOut.push({ kind: 'left-out', reason: 'no-email', personIds: [String(person.personId)], email: null })
      continue
    }
    if (!groups.has(email)) groups.set(email, [])
    groups.get(email).push(person)
  }
  const candidates = []
  for (const [email, members] of groups) {
    members.sort((a, b) => byId(a.personId, b.personId))
    const personIds = members.map(m => String(m.personId))
    if (!isValidEmail(email)) {
      leftOut.push({ kind: 'left-out', reason: 'invalid-email', personIds, email })
      continue
    }
    const d = members[0].detail
    candidates.push({
      email,
      hash: subscriberHash(email),
      personIds,
      firstName: d?.firstName ?? null,
      lastName: d?.lastName ?? null
    })
  }
  candidates.sort((a, b) => byId(a.personIds[0], b.personIds[0]))
  leftOut.sort((a, b) => byId(a.personIds[0], b.personIds[0]))
  return { cohortSize: cohort.length, candidates, leftOut }
}
