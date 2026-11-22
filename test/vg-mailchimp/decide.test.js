import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectArchives, classify, billable, limitAdds, capExceeded, summaryLine } from '../../src/vg-mailchimp/decide.js'

const NOW = Date.parse('2026-11-21T08:00:00Z')
const DAY = 86_400_000
const m = (status, ms) => ({ email_address: 'jane@example.org', status, last_changed: new Date(ms).toISOString() })

test('selectArchives: age boundary', () => {
  const exact = m('unsubscribed', NOW - 30 * DAY)
  const young = m('unsubscribed', NOW - 30 * DAY + 3_600_000)
  assert.deepEqual(selectArchives([exact, young], NOW, 30), [exact])
})

test('selectArchives: only unsubscribed, bad dates never selected', () => {
  const old = NOW - 90 * DAY
  const bad = { email_address: 'a@example.org', status: 'unsubscribed', last_changed: 'garbage' }
  const none = { email_address: 'b@example.org', status: 'unsubscribed' }
  assert.deepEqual(selectArchives([m('subscribed', old), m('cleaned', old), bad, none], NOW, 30), [])
})

test('classify', () => {
  const c = { email: 'jane@example.org' }
  assert.deepEqual(classify(c, null), { action: 'add', reason: undefined })
  assert.equal(classify(c, 'subscribed').action, 'present')
  for (const s of ['pending', 'transactional', 'cleaned', 'archived', 'unsubscribed', 'weird']) {
    assert.deepEqual(classify(c, s), { action: 'skip', reason: s })
  }
})

test('billable', () => {
  assert.equal(billable({ member_count: 4000, unsubscribe_count: 25, cleaned_count: 9 }), 4025)
})

test('limitAdds', () => {
  const adds = Array.from({ length: 15 }, (_, i) => i)
  const r = limitAdds(adds, { billable: 4890, planLimit: 5000, limitMargin: 100 })
  assert.deepEqual(r.add, adds.slice(0, 10))
  assert.deepEqual(r.held, adds.slice(10))
  const over = limitAdds(adds, { billable: 5200, planLimit: 5000, limitMargin: 100 })
  assert.deepEqual(over.add, [])
  assert.equal(over.held.length, 15)
})

test('capExceeded', () => {
  assert.equal(capExceeded(51, 50), true)
  assert.equal(capExceeded(50, 50), false)
  assert.equal(capExceeded(999, null), false)
})

test('summaryLine', () => {
  const s = {
    adds: 3, archives: 1, subscribed: 400,
    leftOut: { 'no-email': 4, 'invalid-email': 1, unsubscribed: 7, limit: 5, pending: 1, 'write-unconfirmed': 1 },
    billable: 4890, planLimit: 5000, writeAdd: true, writeArchive: false
  }
  assert.equal(summaryLine(s),
    'MAILCHIMP OK adds=3 archives=1 subscribed=400 left-out=19 (no-email=4 invalid-email=1 unsubscribed=7 cleaned=0 archived=0 limit=5 cap=0 other=2) billable=4890/5000 writes=add:on,archive:off')
})
