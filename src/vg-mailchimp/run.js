// One run of the VG -> Mailchimp audience service: the spec's "A run", steps 1 to 7, in order.
// Fails closed: a contact is written only when every read before and after the write agrees.
// Read VG, build candidates; read the audience; snapshot (only when a write switch is on); archive
// (re-read before, read back after); re-read billable; classify; add (billing guard, then cap; read
// back after each PUT); report. The records file is written once, at the end, also on failure and stop.

import { buildCandidates } from './cohort.js'
import { subscriberHash } from './mailchimp.js'
import { selectArchives, classify, billable, limitAdds, capExceeded, summaryLine } from './decide.js'

const WRITE_GAP_MS = 300

class Stop extends Error {}

// Every read is raced against the run's signal (pattern copied from the LGL sync's abort helper):
// a read is abandoned the moment the signal fires. Nothing is lost, since a read writes nothing.
function makeRead (signal) {
  return (promise) => {
    if (!signal) return promise
    if (signal.aborted) { promise.catch(() => {}); return Promise.reject(new Stop()) }
    let onAbort
    const stop = new Promise((_, reject) => { onAbort = () => reject(new Stop()); signal.addEventListener('abort', onAbort, { once: true }) })
    return Promise.race([promise, stop]).finally(() => signal.removeEventListener('abort', onAbort))
  }
}

export async function runOnce ({
  config, vg, mc, now, sleep, writeFile, stdout, signal,
  writeAdd, writeArchive, maxAdd, maxArchive,
}) {
  const startMs = now()
  const runId = new Date(startMs).toISOString().replace(/[:.]/g, '-')
  const recordsPath = `${config.outDir}/mailchimp-${runId}.jsonl`
  const records = []
  const record = (r) => records.push({ ...r, at: new Date(now()).toISOString() })
  const saveRecords = () => writeFile(recordsPath, records.map((r) => JSON.stringify(r) + '\n').join(''))

  // Every Mailchimp write goes through here: stop check first, then the 300 ms gap after any earlier write.
  const read = makeRead(signal)
  // A read-back follows a write that has happened: if the run stops during it, the write is still
  // recorded (unconfirmed, status null) before the stop goes on up.
  const readBack = async (promise, onStop) => {
    try { return await read(promise) } catch (err) { if (err instanceof Stop) onStop(); throw err }
  }
  let wrote = false
  const beforeWrite = async () => {
    if (signal?.aborted) throw new Stop()
    if (wrote) await sleep(WRITE_GAP_MS)
    if (signal?.aborted) throw new Stop()
    wrote = true
  }

  try {
    // 1. Read VG. The cohort floor is checked before any Mailchimp request.
    if (signal?.aborted) throw new Stop()
    const persons = await read(vg.listPersons())
    const { cohortSize, candidates, leftOut } = buildCandidates(persons ?? [])
    if (!persons?.length || cohortSize < config.minCohort) {
      throw Object.assign(new Error(`cohort ${cohortSize} is below MIN_COHORT ${config.minCohort}`), { final: true })
    }
    // Cohort left-outs (no-email, invalid-email) never reach Mailchimp, so they carry no hash.
    for (const l of leftOut) record({ kind: 'left-out', reason: l.reason, personIds: l.personIds, email: l.email, hash: null })

    // 2. Read the audience.
    const list = await read(mc.getList())
    const members = await read(mc.listMembers())
    const audience = new Map()
    for (const m of members) audience.set(subscriberHash(m.email_address), m)

    // 3. Snapshot, before any write.
    if (writeAdd || writeArchive) {
      await writeFile(`${config.outDir}/audience-${runId}.json`, JSON.stringify({ taken_at: new Date(now()).toISOString(), list, members }))
    }

    // 4. Archive.
    let archives = 0
    const toArchive = selectArchives(members, startMs, config.archiveAfterDays)
    if (capExceeded(toArchive.length, maxArchive)) {
      stdout(`MAILCHIMP CAP archive=${toArchive.length} max=${maxArchive}`)
    } else if (!writeArchive) {
      archives = toArchive.length
    } else {
      for (const m of toArchive) {
        const email = m.email_address
        const hash = subscriberHash(email)
        const base = { personIds: [], email, hash }
        if (signal?.aborted) throw new Stop()
        const before = await read(mc.getMember(hash))
        if (before?.status !== 'unsubscribed') {
          const status = before?.status ?? null
          record({ kind: 'archive-skipped', reason: status, ...base, status })
          continue
        }
        await beforeWrite()
        await mc.archiveMember(hash)
        const after = await readBack(mc.getMember(hash), () => record({ kind: 'archive-skipped', reason: null, ...base, status: null }))
        const status = after?.status ?? null
        if (status === 'archived') {
          archives++
          record({ kind: 'archived', ...base, status })
        } else {
          record({ kind: 'archive-skipped', reason: status, ...base, status })
        }
      }
    }

    // Billable is re-read after archiving and before the guard.
    const after = await read(mc.getList())
    const used = billable(after.stats)

    // 5. Classify.
    let subscribed = 0
    const adds = []
    for (const c of candidates) {
      const base = { personIds: c.personIds, email: c.email, hash: c.hash }
      let status = audience.get(c.hash)?.status ?? null
      if (status === null) {
        const found = await read(mc.getMember(c.hash))
        status = found === null ? null : (found.status ?? 'unknown')
      }
      const { action, reason } = classify(c, status)
      if (action === 'present') subscribed++
      else if (action === 'skip') record({ kind: 'left-out', reason, ...base, status })
      else adds.push(c)
    }

    // 6. Add: billing guard, then the cap on what the guard lets through.
    const { add, held } = limitAdds(adds, { billable: used, planLimit: config.planLimit, limitMargin: config.limitMargin })
    for (const c of held) record({ kind: 'left-out', reason: 'limit', personIds: c.personIds, email: c.email, hash: c.hash })
    if (held.length) stdout(`MAILCHIMP LIMIT billable=${used} limit=${config.planLimit} margin=${config.limitMargin} held=${held.length}`)

    let added = 0
    if (capExceeded(add.length, maxAdd)) {
      stdout(`MAILCHIMP CAP add=${add.length} max=${maxAdd}`)
      for (const c of add) record({ kind: 'left-out', reason: 'cap', personIds: c.personIds, email: c.email, hash: c.hash })
    } else if (!writeAdd) {
      added = add.length
    } else {
      for (const c of add) {
        const base = { personIds: c.personIds, email: c.email, hash: c.hash }
        await beforeWrite()
        await mc.putMember(c.hash, { email: c.email, firstName: c.firstName, lastName: c.lastName })
        const back = await readBack(mc.getMember(c.hash), () => record({ kind: 'left-out', reason: 'write-unconfirmed', ...base, status: null }))
        const status = back?.status ?? null
        if (status === 'subscribed') {
          added++
          record({ kind: 'added', ...base, status })
        } else {
          record({ kind: 'left-out', reason: 'write-unconfirmed', ...base, status })
        }
      }
    }

    // 7. Report.
    await saveRecords()
    const leftOutCounts = {}
    for (const r of records) if (r.kind === 'left-out') leftOutCounts[r.reason] = (leftOutCounts[r.reason] ?? 0) + 1
    stdout(summaryLine({
      adds: added, archives, subscribed, leftOut: leftOutCounts,
      billable: used, planLimit: config.planLimit, writeAdd, writeArchive,
    }))
    return { outcome: 'ok', retryable: false, runId }
  } catch (err) {
    let saveErr = null
    try { await saveRecords() } catch (e) { saveErr = e }
    const stopped = err instanceof Stop || signal?.aborted
    const suffix = saveErr ? ` (records not written: ${saveErr.message})` : ''
    if (stopped && signal?.reason === 'shutdown') {
      if (saveErr) stdout(`MAILCHIMP FAILED stopped by shutdown${suffix}`)
      return { outcome: 'stopped', retryable: false, runId }
    }
    if (stopped) {
      stdout(`MAILCHIMP FAILED ${signal?.reason === 'timeout' ? 'run timed out' : 'run aborted'}${suffix}`)
      return { outcome: 'failed', retryable: true, runId }
    }
    stdout(`MAILCHIMP FAILED ${err.message}${suffix}`)
    return { outcome: 'failed', retryable: !err.final, runId }
  }
}
