// Applies the plan's LGL writes: the LGL counterpart of apply.js, and the only module that writes to LGL.
// For each constituent in turn: one fresh read, a stale check per field against the value the plan
// saw, the calls built from the fresh record and sent in order, then one sync_log append of every
// call sent. A field's calls stop at its first refusal (400, 404, 422, or an added or revived entry
// LGL stored as not current), which opens an lgl-refused hold; the constituent's other fields go on.
// A refusal after an earlier call of the field was answered opens an lgl-incomplete hold instead.
// A 404 on a retire is not a refusal: the entry is already gone, and the field is written. A 404 on
// a revive is not one either: the entry is gone, so the field is stale and the next run adds it.
// Any other failure fails the run, after logging the calls already sent and the one that failed
// (outcome 'failed': LGL may have applied it). A field left part way (a call answered, a later one
// not) opens an lgl-incomplete hold: the entry the sync read may still be current beside the new one.
// The failed run's error carries what it gathered (e.partial: agree, holds, counts) for apply.js to
// save. A stop (signal aborted) is checked between constituents: the one in hand finishes its calls
// and its log append. Two writes to the same constituent and field fail the run before any is sent.
import { lglFields, comparable, lglExpect, ENTRY_FIELDS } from './fields.js'
import { isRefusal, aborted } from './abort.js'
import { buildLglCalls } from './lgl-calls.js'
import { fingerprint } from './plan.js'

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
    // LGL answers an add with the new entry; without its id the add cannot be checked or retired after
    if (entryId == null) throw new Error(`LGL answered ${call.method} ${call.path} without an entry id`)
    const entry = (await lgl.listEntries(id, call.entryKind, opts)).find((e) => String(e.id) === entryId)
    return Boolean(entry) && !entry.not_current
  }

  const groups = new Map()
  for (const w of writes) {
    const key = String(w.constituentId)
    const group = groups.get(key) ?? []
    // Both would be sent from the same fresh read: the second would add the same entry again.
    if (group.some((x) => x.field === w.field)) {
      throw new Error(`LGL writes for constituent ${key}: two writes to field "${w.field}" in one run`)
    }
    groups.set(key, [...group, w])
  }

  // One constituent: a fresh read, then each of its fields in turn, then one log append.
  const applyGroup = async (id, group) => {
    let fresh
    try {
      fresh = await lgl.getConstituentFull(id, opts)
    } catch (e) {
      if (e?.status !== 404) throw e
      for (const w of group) note(w, 'stale', { note: 'constituent not found' }) // the next full pass sees it missing
      return
    }
    const read = lglFields(fresh)
    const rows = []
    let callsLogged = 0

    // One field: stale check, its calls in order, its memory and holds. Returns nothing; a failure
    // that is not a refusal throws.
    const applyField = async (w) => {
      const { field } = w
      if (lglExpect(read, field) !== w.expect) return note(w, 'stale')
      const { calls, addressee } = buildLglCalls(w, fresh, { addresseeSetting })
      if (!calls.length) return note(w, 'stale', { note: 'no calls' })
      const oldValue = read.problems[field] === 'unclean' ? read.raw[field] : read.values[field]
      const logCall = (call, lglEntryId, outcome, responseStatus, message) => {
        callsLogged++
        for (const personId of w.personIds) {
          rows.push({
            runId, lglConstituentId: id, personId: String(personId), field, case: w.case,
            request: { method: call.method, path: call.path, body: call.body },
            lglEntryId, oldValue, newValue: w.value, outcome, responseStatus,
            note: message == null ? null : String(message).slice(0, 1000),
          })
        }
      }
      // A failure part way, after `done` calls were answered: the field's later calls are not sent,
      // so the entry the next call would have retired may be left current. Staff finish it in LGL.
      let done = 0
      const incomplete = (failed, e) => {
        if (done === 0 || done >= calls.length) return
        holdEach(w, 'lgl-incomplete', fingerprint(['lgl-incomplete', field, w.value]), {
          sent: calls.slice(0, done).map(({ method, path, body }) => ({ method, path, body })),
          failed: { method: failed.method, path: failed.path, body: failed.body, error: e?.message ?? String(e) },
          oldEntryId: calls[done].oldEntryId == null ? null : String(calls[done].oldEntryId),
        })
      }

      // A refusal of the field's first call holds that exact write; one after an earlier call was
      // answered leaves the field part way, which is staff's to finish (lgl-incomplete).
      const refuse = (call, lglEntryId, status, message) => {
        logCall(call, lglEntryId, 'refused', status, message)
        if (done > 0) incomplete(call, { message })
        else {
          holdEach(w, 'lgl-refused', fingerprint([field, comparable(field, w.value)]), {
            error: message, attempted: { method: call.method, path: call.path, body: call.body },
          })
        }
        note(w, 'refused', { note: message })
      }

      let entryWritten = null
      for (const call of calls) {
        let res
        try {
          res = await send(id, call)
        } catch (e) {
          // A retire of an entry LGL no longer has (its daily dedup deletes entries) is done already.
          if (call.step === 'retire' && e?.status === 404) {
            logCall(call, entryIdOf(call, null), 'written', 404, 'already gone')
            done++
            continue
          }
          // A revive of an entry LGL no longer has: the field is stale, and the next run adds the value.
          if (call.step === 'revive' && e?.status === 404) {
            logCall(call, entryIdOf(call, null), 'refused', 404, 'entry gone')
            if (done > 0) incomplete(call, e)
            return note(w, 'stale', { note: 'entry gone' })
          }
          if (!isRefusal(e)) {
            logCall(call, entryIdOf(call, null), 'failed', e?.status ?? null, e?.message ?? String(e))
            incomplete(call, e)
            throw e
          }
          return refuse(call, call.step === 'add' ? null : entryIdOf(call, null), e.status, e.message)
        }
        const entryId = entryIdOf(call, res)
        // Checked before the retire that follows, so a refusal never leaves nothing current.
        if (call.step === 'add' || call.step === 'revive') {
          let current
          try {
            current = await took(id, call, res, entryId)
          } catch (e) {
            logCall(call, entryId, 'written', OK, `not checked: ${e?.message ?? e}`) // it was sent
            done++
            // What failed is the check, not the call: the hold says so, so staff do not add it again.
            const check = entryId == null ? { method: call.method, path: call.path, body: null } : { method: 'GET', path: `/constituents/${id}/${call.entryKind}`, body: null }
            incomplete(check, e)
            throw e
          }
          if (!current) return refuse(call, entryId, OK, NOT_CURRENT)
        }
        if (call.step === 'add' || call.step === 'revive') entryWritten = entryId
        logCall(call, entryId, 'written', OK, null)
        done++
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
      if (rows.length) {
        await vg.appendSyncLog(rows).catch((logError) => {
          e.logError = logError
          // Carried in the message, so the PASS FAILED / CHECK FAILED line names it.
          e.message = `${e.message}; log append also failed: ${logError?.message ?? logError} — ${callsLogged} call(s) sent but not logged`
        })
      }
      throw e
    }
    // A failed append fails the run: a write must not go unrecorded. It is never re-sent.
    if (rows.length) await vg.appendSyncLog(rows)
  }

  try {
    for (const [id, group] of groups) {
      if (aborted(signal)) return { counts, agree, holds, stopped: true }
      await applyGroup(id, group)
    }
  } catch (e) {
    // What the run gathered before it failed, for apply.js to save: memory, and holds (an addressee
    // or lgl-incomplete hold is never found again by a later plan).
    if (e && typeof e === 'object') e.partial = { counts, agree, holds }
    throw e
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
