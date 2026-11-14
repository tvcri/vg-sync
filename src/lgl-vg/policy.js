// Reads policy.json: what to do with each field comparison, and the record-level rules.
// A field/case with no row means hold. The hash identifies the exact text that was read.
import { createHash } from 'node:crypto'
import { FIELDS } from './fields.js'

const CASES = ['same', 'first-match', 'converged', 'lgl-changed', 'vg-changed', 'lgl-cleared', 'vg-cleared', 'both-changed', 'never-agreed']
const ACTIONS = ['to-vg', 'to-lgl', 'hold', 'merge', 'toward-deceased', 'to-lgl-else-hold']
const RECORD_ACTIONS = { 'lgl-missing': ['hold', 'unlink'], 'no-longer-donor': ['hold', 'unlink'] }

function oneOf(what, value, allowed) {
  if (!allowed.includes(value)) throw new Error(`policy: unknown ${what} "${value}" (expected one of ${allowed.join(', ')})`)
}

export function parsePolicy(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch (e) {
    throw new Error(`policy: invalid JSON: ${e.message}`)
  }
  const fields = data.fields ?? {}
  const records = data.records ?? {}
  const settings = data.settings ?? {}

  for (const [field, row] of Object.entries(fields)) {
    oneOf('field', field, FIELDS)
    for (const [kase, action] of Object.entries(row)) {
      oneOf('case', kase, CASES)
      oneOf('action', action, ACTIONS)
    }
  }
  for (const [kind, action] of Object.entries(records)) {
    oneOf('record kind', kind, Object.keys(RECORD_ACTIONS))
    oneOf(`record action for ${kind}`, action, RECORD_ACTIONS[kind])
  }

  return {
    fieldAction: (field, kase) => fields[field]?.[kase] ?? 'hold',
    record: (kind) => records[kind] ?? 'hold',
    setting: (name) => settings[name],
    hash: createHash('sha256').update(text).digest('hex'),
  }
}
