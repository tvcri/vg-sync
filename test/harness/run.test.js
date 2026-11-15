import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planRun, parseArgs, lglDonor, scenarioRows } from '../../harness/run.js'

const scen = (name, n, extra = {}) => ({ name, phases: Array.from({ length: n }, () => ({ expect: { writes: 0 } })), ...extra })
const kinds = (steps) => steps.map((s) => s.kind)

test('two scenarios with 2 and 3 phases: three passes, the shorter checked undisturbed in pass 3', () => {
  const a = scen('a', 2)
  const b = scen('b', 3)
  const steps = planRun({ selected: [a, b], phaseCount: 3 })
  assert.equal(steps[0].kind, 'reseed')
  assert.deepEqual(steps[0].scenarios, ['a', 'b'])
  const passes = steps.filter((s) => s.kind === 'pass')
  assert.deepEqual(passes.map((p) => p.pass), [1, 2, 3])
  const checks3 = steps.filter((s) => s.kind === 'check' && s.pass === 3)
  assert.deepEqual(checks3.map((c) => [c.scenario, c.phase]), [['a', 2], ['b', 2]])
  // a has two phases, so phaseIndex 2 is past its end: the undisturbed check
  assert.ok(checks3[0].phase >= a.phases.length)
  // every pass is followed by the checks for that pass, before the next pass
  const order = steps.filter((s) => s.kind === 'pass' || s.kind === 'check').map((s) => `${s.kind}${s.pass}`)
  assert.deepEqual(order, ['pass1', 'check1', 'check1', 'pass2', 'check2', 'check2', 'pass3', 'check3', 'check3'])
})

test('edits and waits come before their pass, in scenario order', () => {
  const a = { name: 'a', phases: [{ expect: {} }, { edit: { vg: { firstName: 'Janet' } }, wait: 'verification', expect: {} }] }
  const b = { name: 'b', phases: [{ edit: { lgl: { first_name: 'Jo' } }, expect: {} }] }
  const steps = planRun({ selected: [a, b], phaseCount: 2 })
  assert.deepEqual(kinds(steps), ['reseed', 'edit', 'pass', 'check', 'check', 'edit', 'wait', 'pass', 'check', 'check'])
  assert.deepEqual([steps[1].scenario, steps[1].phase], ['b', 0])
  assert.deepEqual([steps[5].scenario, steps[6].scenario, steps[6].wait], ['a', 'a', 'verification'])
})

test('a runAlone scenario comes after the lockstep group with its own reseed', () => {
  const a = scen('a', 1)
  const alone = scen('breaker', 1, { runAlone: true })
  alone.phases[0].args = ['--max-people', '1']
  const steps = planRun({ selected: [alone, a], phaseCount: 1 })
  assert.deepEqual(kinds(steps), ['reseed', 'pass', 'check', 'reseed', 'pass', 'check'])
  assert.deepEqual(steps[0].scenarios, ['a'])
  assert.deepEqual(steps[3].scenarios, ['breaker'])
  assert.deepEqual(steps[4].args, ['--max-people', '1'])
  assert.deepEqual(steps[1].args, [])
  assert.deepEqual(steps.filter((s) => s.kind === 'pass').map((p) => p.pass), [1, 2])
  assert.equal(steps[5].scenario, 'breaker')
})

test('a lockstep group of only runAlone scenarios has no lockstep reseed', () => {
  const steps = planRun({ selected: [scen('x', 2, { runAlone: true })], phaseCount: 2 })
  assert.deepEqual(kinds(steps), ['reseed', 'pass', 'check', 'pass', 'check'])
  assert.deepEqual(planRun({ selected: [], phaseCount: 0 }), [])
})

test('phase args from the lockstep group are merged once', () => {
  const a = { name: 'a', phases: [{ args: ['--max-people', '5'] }] }
  const b = { name: 'b', phases: [{ args: ['--max-people', '5'] }] }
  const steps = planRun({ selected: [a, b], phaseCount: 1 })
  assert.deepEqual(steps.find((s) => s.kind === 'pass').args, ['--max-people', '5'])
})

test('parseArgs reads the flags', () => {
  assert.deepEqual(parseArgs([]), { only: null, step: 6, overnight: false, resume: false, guardsOnly: false })
  const o = parseArgs(['--only', 'smoke', '--only', 'names', '--step', '4', '--overnight', '--resume', '--guards-only'])
  assert.deepEqual(o, { only: ['smoke', 'names'], step: 4, overnight: true, resume: true, guardsOnly: true })
  assert.throws(() => parseArgs(['--step', 'x']), /--step/)
  assert.throws(() => parseArgs(['--only']), /--only/)
  assert.throws(() => parseArgs(['--bogus']), /Unknown/)
})

test('lglDonor: seeded and edit-added non-dues gifts up to the phase', () => {
  const s = {
    gifts: [{ date: '-30d', amount: 10 }, { date: '-5d', amount: 5, dues: true }],
    phases: [{}, { edit: { lgl: { gifts: [{ date: '-2d', amount: 20 }] } } }],
  }
  assert.deepEqual(lglDonor(s, 0, '2026-11-13'), { donor: true, lastGiftDate: '2026-10-14' })
  assert.deepEqual(lglDonor(s, 1, '2026-11-13'), { donor: true, lastGiftDate: '2026-11-11' })
  assert.deepEqual(lglDonor({ gifts: [{ date: '-1d', amount: 5, dues: true }], phases: [] }, 0, '2026-11-13'), { donor: false, lastGiftDate: null })
})

test('scenarioRows picks the scenario\'s decisions and holds', () => {
  const entry = { constituentId: 77, personIds: ['5', '6'] }
  const decisions = [{ personId: '5' }, { personId: '9' }, { constituentId: '77', kind: 'record' }, { personId: '6' }]
  const holds = [{ personId: 5 }, { personId: '8' }, { personId: null, lglConstituentId: 77 }, { personId: null, lglConstituentId: 78 }]
  const r = scenarioRows(entry, { decisions, holds })
  assert.equal(r.decisions.length, 3)
  assert.equal(r.holds.length, 2)
})

test('formatReport: one line per scenario, failures indented, totals', async () => {
  const { formatReport } = await import('../../harness/run.js')
  const text = formatReport({
    selected: [{ name: 'a' }, { name: 'b' }],
    results: { b: [{ phase: 2, what: 'writes', expected: 0, found: 1 }] },
    passFailures: [{ pass: 2, code: 1 }],
  })
  assert.deepEqual(text.split('\n'), [
    'PASS a', 'FAIL b', '    phase 2  writes: expected 0, found 1', 'pass 2 exited 1',
    '1 passed, 1 failed, 0 known, 1 pass(es) exited non-zero',
  ])
})

test('formatReport: failures only in known phases are KNOWN, not FAIL; a known phase that passes says so', async () => {
  const { formatReport } = await import('../../harness/run.js')
  const k = { name: 'k', phases: [{}, { known: 'the app says a staff dismissal is permanent' }] }
  const mixed = { name: 'm', phases: [{}, { known: 'x' }] }
  const fixed = { name: 'f', phases: [{ known: 'old note' }] }
  const text = formatReport({
    selected: [k, mixed, fixed],
    results: {
      k: [{ phase: 2, what: 'holds', expected: ['a'], found: ['b'] }],
      m: [{ phase: 1, what: 'writes', expected: 0, found: 1 }, { phase: 2, what: 'writes', expected: 0, found: 1 }],
    },
    passFailures: [],
  })
  assert.deepEqual(text.split('\n'), [
    'KNOWN k',
    '    phase 2 known: the app says a staff dismissal is permanent',
    '    phase 2  holds: expected ["a"], found ["b"]',
    'FAIL m',
    '    phase 1  writes: expected 0, found 1',
    '    phase 2  writes: expected 0, found 1',
    'PASS f',
    '    phase 1 is marked known but passed: old note',
    '1 passed, 1 failed, 1 known, 0 pass(es) exited non-zero',
  ])
})

test('planRun marks a pass whose runAlone scenario expects it to fail', () => {
  const alone = { name: 'breaker', runAlone: true, phases: [{ args: ['--max-people', '1'], expect: { passFails: true } }, { expect: { writes: 0 } }] }
  const passes = planRun({ selected: [scen('a', 1), alone], phaseCount: 1 }).filter((s) => s.kind === 'pass')
  assert.deepEqual(passes.map((p) => p.expectFail), [false, true, false])
})

test('a group with an import decision gets a seed-import step right after its reseed', async () => {
  const { planRun, importRun } = await import('../../harness/run.js')
  const s = (name, o = {}) => ({ name, phases: [{ run: 'full' }], ...o })
  const steps = planRun({ selected: [s('a'), s('b', { importDecision: 'staff-skip' })] })
  assert.deepEqual(steps.slice(0, 2).map((x) => [x.kind, x.scenarios]), [['reseed', ['a', 'b']], ['seed-import', ['b']]])
  const run = importRun([s('a'), s('b', { importDecision: 'horizon-skip', gifts: [{ date: '-6y' }, { date: '-1d', dues: true }] })],
    { scenarios: { a: { constituentId: 1 }, b: { constituentId: 2 } } }, '2026-11-14')
  assert.deepEqual(run, { target: 'harness', executed: true, actions: [{ key: '2', lglId: '2', name: 'b', kind: 'skip', reason: 'Last gift before the horizon; new people only for gifts since', lastGiftDate: '2020-11-14' }] })
})

test('scenarioRows takes holds naming the scenario\'s constituent, with or without a person', async () => {
  const { scenarioRows } = await import('../../harness/run.js')
  const holds = [{ personId: '500', lglConstituentId: '2' }, { personId: null, lglConstituentId: '2' }, { personId: '9', lglConstituentId: '3' }]
  assert.equal(scenarioRows({ constituentId: 2, personIds: [] }, { decisions: [], holds }).holds.length, 2)
})

test('planRun puts the run kind on the pass step', () => {
  const s = { name: 'c', runAlone: true, phases: [{ run: 'full' }, { run: 'lgl-check' }, { run: 'vg-check' }, {}] }
  const passes = planRun({ selected: [s] }).filter((x) => x.kind === 'pass')
  assert.deepEqual(passes.map((p) => p.run), ['full', 'lgl-check', 'vg-check', 'full'])
  const lockstep = planRun({ selected: [scen('a', 1)], phaseCount: 1 }).find((x) => x.kind === 'pass')
  assert.equal(lockstep.run, 'full')
})

test('runAlone scenarios with the same group name share a reseed and their passes', () => {
  const held = { name: 'held', runAlone: 'pair', phases: [{ run: 'full' }, { run: 'lgl-check' }] }
  const edited = { name: 'edited', runAlone: 'pair', phases: [{ run: 'full' }, { run: 'lgl-check', edit: { lgl: {} } }] }
  const solo = { name: 'solo', runAlone: true, phases: [{ run: 'full' }] }
  const steps = planRun({ selected: [held, solo, edited] })
  assert.deepEqual(kinds(steps), ['reseed', 'pass', 'check', 'check', 'edit', 'pass', 'check', 'check', 'reseed', 'pass', 'check'])
  assert.deepEqual(steps[0].scenarios, ['held', 'edited'])
  assert.deepEqual(steps[8].scenarios, ['solo'])
  assert.deepEqual(steps.filter((x) => x.kind === 'pass').map((p) => p.run), ['full', 'lgl-check', 'full'])
})

test('planRun rejects a group whose scenarios name different runs for one phase', () => {
  const a = { name: 'a', runAlone: 'pair', phases: [{ run: 'lgl-check' }] }
  const b = { name: 'b', runAlone: 'pair', phases: [{ run: 'vg-check' }] }
  assert.throws(() => planRun({ selected: [a, b] }), /phase 1.*lgl-check.*vg-check/)
})

test('parseArgs: --step defaults to 6', () => {
  assert.equal(parseArgs([]).step, 6)
})
