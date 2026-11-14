import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDate, loadScenarios, selectScenarios, phaseCount } from '../../harness/scenario.js'

const ok = (name, extra = {}) => ({ name, why: 'w', since: 3, phases: [{ run: 'full', expect: {} }], ...extra })

test('resolveDate offsets and literals', () => {
  assert.equal(resolveDate('-30d', '2026-11-13'), '2026-10-14')
  assert.equal(resolveDate('-2y', '2026-11-13'), '2024-11-13')
  assert.equal(resolveDate('+0d', '2026-11-13'), '2026-11-13')
  assert.equal(resolveDate('2020-02-29', '2026-11-13'), '2020-02-29')
  assert.throws(() => resolveDate('soon', '2026-11-13'), /soon/)
})

test('loadScenarios flattens, tags the area and rejects bad input', () => {
  const list = loadScenarios([{ area: 'names', default: [ok('a')] }, { area: 'phones', default: [ok('b')] }])
  assert.deepEqual(list.map((s) => [s.name, s.area]), [['a', 'names'], ['b', 'phones']])
  assert.throws(() => loadScenarios([{ area: 'x', default: [ok('a'), ok('a')] }]), /Duplicate.*a/)
  for (const k of ['name', 'why', 'since', 'phases']) {
    const s = ok('a'); delete s[k]
    assert.throws(() => loadScenarios([{ area: 'x', default: [s] }]), new RegExp(`"${k}"`))
  }
  assert.throws(() => loadScenarios([{ area: 'x', default: [ok('a', { bogus: 1 })] }]), /"bogus"/)
  assert.throws(() => loadScenarios([{ area: 'x', default: [ok('a', { phases: [{ run: 'full', oops: 1 }] })] }]), /a.*"oops"/)
  assert.throws(() => loadScenarios([{ area: 'x', default: [ok('a', { phases: [{ run: 'dry' }] })] }]), /run/)
  assert.throws(() => loadScenarios([{ area: 'x', default: [ok('a', { phases: [null] })] }]), /"a" phase 1/)
})

test('selectScenarios filters by name, area, step and overnight', () => {
  const list = loadScenarios([
    { area: 'names', default: [ok('a'), ok('late', { since: 5 }), ok('night', { overnight: true })] },
    { area: 'phones', default: [ok('b')] },
  ])
  let r = selectScenarios(list, {})
  assert.deepEqual(r.selected.map((s) => s.name), ['a', 'b'])
  assert.deepEqual(r.skipped, [{ name: 'late', reason: 'since step 5' }, { name: 'night', reason: 'overnight' }])
  assert.deepEqual(selectScenarios(list, { overnight: true }).selected.map((s) => s.name), ['a', 'night', 'b'])
  assert.deepEqual(selectScenarios(list, { step: 5 }).selected.map((s) => s.name), ['a', 'late', 'b'])
  assert.deepEqual(selectScenarios(list, { step: 3 }).selected.map((s) => s.name), ['a', 'b'])
  assert.deepEqual(selectScenarios(list, { only: 'phones' }).selected.map((s) => s.name), ['b'])
  assert.deepEqual(selectScenarios(list, { only: 'a' }).selected.map((s) => s.name), ['a'])
})

test('phaseCount is the largest phase list', () => {
  assert.equal(phaseCount([ok('a'), ok('b', { phases: [{}, {}, {}] })]), 3)
  assert.equal(phaseCount([]), 0)
})

test('args and passFails are allowed only on runAlone scenarios', () => {
  const withArgs = { phases: [{ run: 'full', args: ['--max-people', '1'], expect: { passFails: true } }] }
  assert.equal(loadScenarios([{ area: 'x', default: [ok('a', { ...withArgs, runAlone: true })] }]).length, 1)
  assert.throws(() => loadScenarios([{ area: 'x', default: [ok('a', { phases: [{ run: 'full', args: ['--max-people', '1'] }] })] }]),
    /"a" phase 1: args.*runAlone/)
  assert.throws(() => loadScenarios([{ area: 'x', default: [ok('a', { phases: [{ run: 'full', expect: { passFails: true } }] })] }]),
    /"a" phase 1: passFails.*runAlone/)
  assert.throws(() => loadScenarios([{ area: 'x', default: [ok('a', { runAlone: true, phases: [{ run: 'full', expect: { passFails: 'yes' } }] })] }]),
    /passFails must be true/)
})

test('importDecision must be a known decision', () => {
  assert.equal(loadScenarios([{ area: 'x', default: [ok('a', { importDecision: 'staff-skip' })] }])[0].importDecision, 'staff-skip')
  assert.throws(() => loadScenarios([{ area: 'x', default: [ok('a', { importDecision: 'maybe' })] }]), /importDecision must be one of/)
})
