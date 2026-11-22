import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMailchimpClient, subscriberHash } from '../../src/vg-mailchimp/mailchimp.js'
import { createMockMailchimpFetch, openMailchimp } from '../../src/vg-mailchimp/mailchimp-mock.js'

const T0 = '2026-11-01T00:00:00Z'
const member = (email, status, first = 'X', last = 'Y') => ({
  email_address: email, status, last_changed: T0, merge_fields: { FNAME: first, LNAME: last },
})
const state = () => ({
  list: { id: 'list1', name: 'Test List' },
  members: [
    member('jane@example.org', 'subscribed', 'Jane', 'Doe'),
    member('john@example.org', 'unsubscribed', 'John', 'Roe'),
    member('old@example.org', 'archived'),
    member('bounce@example.org', 'cleaned'),
  ],
})

function setup (s = state()) {
  const saved = []
  const fetchImpl = createMockMailchimpFetch({
    state: s,
    persist: async (x) => { saved.push(JSON.parse(JSON.stringify(x))) },
    now: () => Date.parse('2026-11-21T12:00:00Z'),
  })
  const mc = createMailchimpClient({ apiKey: 'mock-us0', listId: 'list1', fetchImpl, sleep: async () => {}, baseUrl: 'https://mock.api.mailchimp.com/3.0' })
  return { mc, saved, s, fetchImpl }
}

test('getList answers id, name and counts from the state; another list id is 404', async () => {
  const { mc, fetchImpl } = setup()
  const l = await mc.getList()
  assert.equal(l.id, 'list1')
  assert.equal(l.name, 'Test List')
  assert.deepEqual([l.stats.member_count, l.stats.unsubscribe_count, l.stats.cleaned_count], [1, 1, 1])
  const other = createMailchimpClient({ apiKey: 'mock-us0', listId: 'nope', fetchImpl, sleep: async () => {}, baseUrl: 'https://mock.api.mailchimp.com/3.0' })
  await assert.rejects(other.getList(), (e) => e.status === 404)
})

test('listMembers pages over non-archived members with total_items', async () => {
  const { mc, fetchImpl } = setup()
  const all = await mc.listMembers()
  assert.deepEqual(all.map((m) => m.email_address), ['jane@example.org', 'john@example.org', 'bounce@example.org'])
  const r = await fetchImpl('https://mock.api.mailchimp.com/3.0/lists/list1/members?count=2&offset=1', { method: 'GET' })
  const body = JSON.parse(await r.text())
  assert.equal(body.total_items, 3)
  assert.equal(body.members.length, 2)
  assert.equal(body.members[0].email_address, 'john@example.org')
})

test('getMember returns a member, archived included, or null for 404', async () => {
  const { mc } = setup()
  assert.equal((await mc.getMember(subscriberHash('jane@example.org'))).status, 'subscribed')
  assert.equal((await mc.getMember(subscriberHash('old@example.org'))).status, 'archived')
  assert.equal(await mc.getMember(subscriberHash('nobody@example.org')), null)
})

test('putMember creates an absent member as subscribed, stamps last_changed and saves', async () => {
  const { mc, saved, s } = setup()
  const r = await mc.putMember(subscriberHash('New@Example.org '), { email: 'new@example.org', firstName: 'Ann', lastName: 'Lee' })
  assert.equal(r.status, 'subscribed')
  assert.equal(r.last_changed, '2026-11-21T12:00:00.000Z')
  assert.deepEqual(r.merge_fields, { FNAME: 'Ann', LNAME: 'Lee' })
  assert.equal(s.members.length, 5)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].members.at(-1).email_address, 'new@example.org')
})

test('putMember of a new address at invalid.example is refused 400 "looks fake or invalid", nothing saved', async () => {
  const { mc, saved, s } = setup()
  const email = 'jane.doe@invalid.example'
  await assert.rejects(mc.putMember(subscriberHash(email), { email, firstName: 'Jane', lastName: 'Doe' }), (e) => {
    assert.equal(e.status, 400)
    assert.match(e.detail, /looks fake or invalid/)
    return true
  })
  assert.equal(s.members.length, 4)
  assert.equal(saved.length, 0)
})

test('putMember on an archived member answers 200 and changes nothing', async () => {
  const { mc, saved, s } = setup()
  const r = await mc.putMember(subscriberHash('old@example.org'), { email: 'old@example.org', firstName: 'A', lastName: 'B' })
  assert.equal(r.status, 'archived')
  assert.deepEqual(s.members[2], member('old@example.org', 'archived'))
  assert.equal(saved.length, 1)
})

test('putMember on any other status updates merge fields only, never the status', async () => {
  const { mc, s } = setup()
  const r = await mc.putMember(subscriberHash('john@example.org'), { email: 'john@example.org', firstName: 'Johnny', lastName: 'Roe' })
  assert.equal(r.status, 'unsubscribed')
  assert.equal(s.members[1].merge_fields.FNAME, 'Johnny')
  assert.equal(s.members[1].status, 'unsubscribed')
})

test('archiveMember sets status archived; an absent member is 404', async () => {
  const { mc, saved, s } = setup()
  await mc.archiveMember(subscriberHash('jane@example.org'))
  assert.equal(s.members[0].status, 'archived')
  assert.equal(saved.length, 1)
  await assert.rejects(mc.archiveMember(subscriberHash('nobody@example.org')), (e) => e.status === 404)
})

test('any other route is 404 mock Mailchimp: no route', async () => {
  const { fetchImpl } = setup()
  const r = await fetchImpl('https://mock.api.mailchimp.com/3.0/ping', { method: 'GET' })
  assert.equal(r.status, 404)
  assert.match(await r.text(), /mock Mailchimp: no route/)
})

test('openMailchimp: with a mock file the client runs over it and saves; without, the real client; a bad file refuses', async () => {
  const files = { 'out/mc.json': JSON.stringify(state()), 'out/bad.json': '{}' }
  const deps = {
    readFile: async (p) => { if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files[p] },
    writeFile: async (p, t) => { files[p] = t },
    now: () => Date.parse('2026-11-21T12:00:00Z'),
    sleep: async () => {},
    fetchImpl: async () => { throw new Error('network') },
  }
  const cfg = (mock, apiKey = '') => ({ mailchimp: { apiKey, listId: 'list1', listName: '', mock } })
  const { mc, mock } = await openMailchimp(cfg('out/mc.json'), deps)
  assert.equal(mock, 'out/mc.json')
  await mc.archiveMember(subscriberHash('jane@example.org'))
  assert.equal(JSON.parse(files['out/mc.json']).members[0].status, 'archived')
  await assert.rejects(openMailchimp(cfg('out/none.json'), deps), /MAILCHIMP_MOCK state file out\/none.json could not be read/)
  await assert.rejects(openMailchimp(cfg('out/bad.json'), deps), /MAILCHIMP_MOCK state file out\/bad.json has no list or members/)
  const real = await openMailchimp(cfg(null, 'k-us1'), deps)
  assert.equal(real.mock, null)
  await assert.rejects(real.mc.getList(), /network/)
})
