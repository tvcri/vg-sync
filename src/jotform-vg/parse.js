// Reads one JotForm Friendly Calls & Visits submission into the shape VG's sync PUT takes.
// Activity mapping is ported from the July prototype. Pure: no I/O.
// Question ids: 2 volunteer name, 3 member name, 4 visit date, 5 minutes, 6 contact type,
// 8 notes, 10 village, 13 reporting tag, 21 activity types, 23 volunteer email.
import { nameKey } from './names.js'

// Column limits from VG's FcvSyncSubmissionPut schema. Longer values are trimmed, because VG answers 400
// to them and the report would then fail every pass.
export const LIMITS = {
  activityOther: 500,
  namePart: 100,
  rawName: 200,
  volunteerEmail: 254,
  contactType: 50,
  villageName: 200
}

// Exact JotForm option text, including the non-breaking spaces in the Outing option.
const ACTIVITY_TYPE_MAP = {
  'Companionship/Friendly Conversation (sharing stories, current events, photos)': 'companionship',
  'Shared Activity (board game, cards, puzzles, craft)': 'activity',
  'Assistance (reading aloud, writing a letter, helping with simple tasks)': 'assistance',
  'Outdoors (walking, gardening, birding, etc)': 'outdoors',
  'Outing (\xa0events, movies, Sr Center,\xa0 etc.)': 'outing',
  'Dining out': 'dining',
  'Wellness check-in (follow up after illness or hospitalization)': 'wellness',
  'Pet visit': 'pet',
  'Other': 'other'
}

function mapActivityTypes(answers) {
  if (!answers) return []
  if (typeof answers === 'string') return [ACTIVITY_TYPE_MAP[answers] ?? answers]
  if (Array.isArray(answers)) return answers.map(a => ACTIVITY_TYPE_MAP[a] ?? a)
  // Dict form: numeric keys hold standard activity strings, "other" key indicates Other was selected
  const values = Object.entries(answers)
    .filter(([k]) => k !== 'other')
    .map(([, v]) => ACTIVITY_TYPE_MAP[v] ?? v)
  if ('other' in answers) values.push('other')
  return values
}

function extractActivityOther(answers) {
  if (!answers || Array.isArray(answers) || typeof answers !== 'object') return null
  const text = answers.other ?? null
  return text || null
}

// A string answer trimmed, or null for absent, empty or whitespace.
function text(answer, max) {
  if (typeof answer !== 'string') return null
  const s = answer.trim()
  if (!s) return null
  return max ? s.slice(0, max) : s
}

function realDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(s)) return null
  const d = s.slice(0, 10)
  const t = new Date(`${d}T00:00:00Z`)
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d ? d : null
}

// A date from a JotForm datetime control ({ datetime: 'YYYY-MM-DD …' }) or a plain string.
function dateAnswer(answer) {
  return realDate(typeof answer === 'string' ? answer.trim() : answer?.datetime)
}

function name(answer) {
  const first = text(answer?.first, LIMITS.namePart)
  const last = text(answer?.last, LIMITS.namePart)
  const raw = [text(answer?.first), text(answer?.last)].filter(Boolean).join(' ').slice(0, LIMITS.rawName) || null
  return { first, last, raw }
}

export function parseSubmission(sub, villagesByName) {
  const a = sub.answers ?? {}
  const villageTyped = text(a[10]?.answer)
  const villageId = villageTyped !== null ? (villagesByName.get(villageTyped) ?? null) : null
  const visitDate = dateAnswer(a[4]?.answer)
  const minutes = text(a[5]?.answer)
  const timeSpentMinutes = minutes !== null && /^\d{1,9}$/.test(minutes) ? parseInt(minutes, 10) : null
  const contactType = text(a[6]?.answer, LIMITS.contactType)
  const activityOther = extractActivityOther(a[21]?.answer)

  const volunteer = name(a[2]?.answer)
  const member = name(a[3]?.answer)
  let unreadable = null
  if (villageId === null) unreadable = 'village'
  else if (visitDate === null) unreadable = 'visit-date'
  else if (timeSpentMinutes === null) unreadable = 'time-spent'
  else if (contactType === null) unreadable = 'contact-type'
  else if (nameKey(volunteer.raw) === '') unreadable = 'volunteer-name'
  else if (nameKey(member.raw) === '') unreadable = 'member-name'

  return {
    id: sub.id,
    submittedAt: sub.created_at,
    jotformUpdatedAt: sub.updated_at || null,
    villageId,
    villageName: villageTyped === null ? null : villageTyped.slice(0, LIMITS.villageName),
    volunteer,
    member,
    volunteerEmail: text(a[23]?.answer, LIMITS.volunteerEmail),
    visitDate,
    timeSpentMinutes,
    contactType,
    activityTypes: mapActivityTypes(a[21]?.answer),
    activityOther: typeof activityOther === 'string' ? (text(activityOther, LIMITS.activityOther)) : null,
    notes: text(a[8]?.answer),
    reportingTag: dateAnswer(a[13]?.answer),
    unreadable
  }
}
