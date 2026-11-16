// Applies the plan's LGL writes: the LGL counterpart of apply.js, and the only module that writes to LGL.
// For each constituent in turn: one fresh read, a stale check per field against the value the plan
// saw, the calls built from the fresh record and sent in order, then one sync_log append of every
// call sent. A field's calls stop at its first refusal (400, 404, 422, or an added or revived entry
// LGL stored as not current), which opens an lgl-refused hold; the constituent's other fields go on.
// Any other failure fails the run, after logging the calls already sent. A stop (signal aborted) is
// checked between constituents: the one in hand finishes its calls and its log append.
import { lglFields, comparable } from './fields.js'
import { buildLglCalls } from './lgl-calls.js'
import { fingerprint } from './plan.js'

const isRefusal = (e) => [400, 404, 422].includes(e?.status)
const aborted = (signal) => signal?.aborted === true
// The fields whose memory row names the LGL entry written (as plan.js records them).
const ENTRY_FIELDS = new Set(['address', 'email'])
// The client returns a write's body only when LGL answered OK; LGL answers its writes with 200.
const OK = 200
const NOT_CURRENT = 'LGL stored the entry as not current'

// writes: the plan's lglWrites to send. attempts bounds each LGL call's retries (a check passes 1).
export async function applyLglWrites(writes, { lgl, vg, runId = null, policy = null, log = () => {}, signal = null, attempts } = {}) {
  const counts = { written: 0, stale: 0, refused: 0 }
  const agree = []
  const holds = []
  const addresseeSetting = policy?.setting('lgl-addressee') ?? 'if-default'
  const opts = attempts === undefined ? {} : { attempts }

  const note = (w, outcome, extra) => {
    for (const personId of w.personIds) {
      log({ kind: 'lgl', personId: String(personId), constituentId: String(w.constituentId), field: w.field, outcome, ...extra })
    }
    counts[outcome]++
  }
  const holdEach = (w, reason, fp, detail) => {
    for (const personId of w.personIds) {
      holds.push({ lglConstituentId: String(w.constituentId), personId: String(personId), field: w.field, reason, fingerprint: fp, detail })
    }
  }

  const send = (id, call) => {
    if (call.step === 'set') return lgl.patchConstituent(id, call.body, opts)
    if (call.step === 'add') return lgl.addEntry(id, call.entryKind, call.body, opts)
    return lgl.patchEntry(call.entryKind, entryIdInPath(call), call.body, opts)
  }
  // An added or revived entry must be current; the response says so, or the list is read for it.
  const took = async (id, call, res, entryId) => {
    if (res?.not_current !== undefined) return !res.not_current
    if (entryId == null) return false
    const entry = (await lgl.listEntries(id, call.entryKind, opts)).find((e) => String(e.id) === entryId)
    return Boolean(entry) && !entry.not_current
  }

  const groups = new Map()
  for (const w of writes) {
    const key = String(w.constituentId)
    groups.set(key, [...(groups.get(key) ?? []), w])
  }

  for (const [id, group] of groups) {
    if (aborted(signal)) return { counts, agree, holds, stopped: true }
    let fresh
    try {
      fresh = await lgl.getConstituentFull(id, opts)
    } catch (e) {
      if (e?.status !== 404) throw e
      for (const w of group) note(w, 'stale', { note: 'constituent not found' }) // the next full pass sees it missing
      continue
    }
    const read = lglFields(fresh)
    const rows = []

    // One field: stale check, its calls in order, its memory and holds. Returns nothing; a failure
    // that is not a refusal throws.
    const applyField = async (w) => {
      const { field } = w
      if (comparable(field, read.values[field]) !== w.expect) return note(w, 'stale')
      const { calls, addressee } = buildLglCalls(w, fresh, { addresseeSetting })
      if (!calls.length) return note(w, 'stale', { note: 'no calls' })
      const oldValue = read.problems[field] === 'unclean' ? read.raw[field] : read.values[field]
      const logCall = (call, lglEntryId, outcome, responseStatus, message) => {
        for (const personId of w.personIds) {
          rows.push({
            runId, lglConstituentId: id, personId: String(personId), field, case: w.case,
            request: { method: call.method, path: call.path, body: call.body },
            lglEntryId, oldValue, newValue: w.value, outcome, responseStatus,
            note: message == null ? null : String(message).slice(0, 1000),
          })
        }
      }
      const refuse = (call, lglEntryId, status, message) => {
        logCall(call, lglEntryId, 'refused', status, message)
        holdEach(w, 'lgl-refused', fingerprint([field, comparable(field, w.value)]), {
          error: message, attempted: { method: call.method, path: call.path, body: call.body },
        })
        note(w, 'refused', { note: message })
      }

      let entryWritten = null
      for (const call of calls) {
        let res
        try {
          res = await send(id, call)
        } catch (e) {
          if (!isRefusal(e)) throw e
          return refuse(call, call.step === 'add' ? null : entryIdOf(call, null), e.status, e.message)
        }
        const entryId = entryIdOf(call, res)
        // Checked before the retire that follows, so a refusal never leaves nothing current.
        if ((call.step === 'add' || call.step === 'revive') && !(await took(id, call, res, entryId))) {
          return refuse(call, entryId, OK, NOT_CURRENT)
        }
        if (call.step === 'add' || call.step === 'revive') entryWritten = entryId
        logCall(call, entryId, 'written', OK, null)
      }
      note(w, 'written')
      // A merge records no memory: the next run reads both sides and finds first-match if they agree.
      if (!w.merge) {
        for (const personId of w.personIds) {
          agree.push({
            personId: String(personId), field, lglConstituentId: id, value: w.value,
            lglEntryId: ENTRY_FIELDS.has(field) ? entryWritten : null,
          })
        }
      }
      // The name is written and a hand-written envelope left: a to-do for staff, opened once.
      if (addressee === 'left') {
        holdEach(w, 'addressee', fingerprint(['addressee', field, w.value]), {
          addressee: fresh.addressee ?? null, salutation: fresh.salutation ?? null, written: w.value,
        })
      }
    }

    try {
      for (const w of group) await applyField(w)
    } catch (e) {
      // The calls already sent are recorded before the run fails; the error that failed it is kept.
      if (rows.length) await vg.appendSyncLog(rows).catch((logError) => { e.logError = logError })
      throw e
    }
    // A failed append fails the run: a write must not go unrecorded. It is never re-sent.
    if (rows.length) await vg.appendSyncLog(rows)
  }
  return { counts, agree, holds, stopped: false }
}

const entryIdInPath = (call) => call.path.split('/').pop()

// The LGL entry a call touched: the new entry's id for an add, the path's for a revive or retire,
// none for a constituent PATCH.
function entryIdOf(call, res) {
  if (call.step === 'set') return null
  if (call.step === 'add') return res?.id == null ? null : String(res.id)
  return entryIdInPath(call)
}
