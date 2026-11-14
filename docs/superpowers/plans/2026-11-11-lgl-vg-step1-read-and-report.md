# LGL ↔ VG Step 1 (Read and Report) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A command that reads LGL and VG, writes nothing to either, and reports how many linked donor fields agree or differ today and what matching would do with unlinked donors.

**Architecture:** Pure modules (donor rule, cleaning, field extraction, comparison, matching, report) fed by two thin I/O clients (LGL REST, VG API with a Keycloak client-credentials token). `main.js report` wires them and prints counts; row-level detail goes to a gitignored directory. These are the same modules the later sync passes will use, so their interfaces are final, not throwaway.

**Tech Stack:** Node 24, ES modules, `node:test` + `node:assert/strict`, global `fetch`. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-11-lgl-vg-sync-design.md` (build order step 1). Background: `docs/context-2026-11-11.md`, `CLAUDE.md`.

## Global Constraints

- Node `>=24`, `"type": "module"`, zero runtime dependencies, zero devDependencies.
- Tests: `node --test`, files under `test/lgl-vg/`, pure functions or injected `fetch`. No test touches the network.
- **This repo is public.** Every fixture is invented: names like Jane Doe, emails at `example.org`, phones `401-555-01xx`, small made-up ids. Never copy a value from the sibling projects' data or `.env` files. Do not port `lglUrl`/`vgUrl` from `suggest.js`; they contain the customer's hostnames.
- **Nothing in this plan writes to LGL, and the report writes nothing to VG.** The LGL client exposes GET only. The VG client exposes GET only, plus the token POST to Keycloak and one setup call that records the service account's own privacy acknowledgement (Task 10).
- **The implementer never runs `main.js report` against real systems.** The engineer runs it. Verification is the test suite.
- Row-level output (real people) goes only under `out/`, which is gitignored. Standard output carries counts only.
- LGL fund and payment-type ids come from the environment, never from source.
- Code ported from `~/dev/tvcri/vg-utils/lgl-import` gets a one-line comment naming the source file and the date `2026-11-11`.
- Field names, everywhere, exactly: `firstName`, `lastName`, `suffix`, `nickname`, `address`, `email`, `phone`, `cell`, `deceased`.
- Work on a branch `lgl-vg-step1` cut from `lgl-vg-design`. Commit after each task.

## Review Focus

1. **LGL answers 429 or 5xx with no `Retry-After`.** Expected: back off long enough to outlast LGL's five-minute pause, then succeed; not give up after twelve seconds. (Task 2)
2. **The VG token expires mid-run, or the API answers 401.** Expected: fetch a new token once and retry; a second 401 is an error. (Task 3)
3. **The service account lacks `donor:read`,** so `donor` is absent from every person. Expected: a clear failure naming the missing permission, not a report of zero linked pairs. (Task 3)
4. **A constituent with no addresses, emails or phones, or with nulls in every optional field.** Expected: empty values, no exception. (Task 5)
5. **A VG donor row pointing at a constituent that is not in the LGL pull,** or at one that no longer passes the donor rule. Expected: counted under their own headings, excluded from field comparison. (Task 8)

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `.env.example`, `.github/workflows/test.yml` | Project shell |
| `src/lgl-vg/config.js` | Read and validate environment |
| `src/lgl-vg/lgl.js` | LGL REST client, read-only |
| `src/lgl-vg/vg.js` | Keycloak token and VG API reads |
| `src/lgl-vg/donors.js` | Donor rule and last gift date |
| `src/lgl-vg/clean.js` | Cleaning of LGL values |
| `src/lgl-vg/fields.js` | Field values from an LGL constituent and from a VG person; comparable form |
| `src/lgl-vg/compare.js` | Three-way comparison |
| `src/lgl-vg/match.js` | Matching unlinked donors |
| `src/lgl-vg/report.js` | Aggregate everything into a report |
| `src/lgl-vg/main.js` | Command line |

Shared data shapes, used by several tasks:

```js
// A VG person as GET /persons?projection=detail returns it (only the parts used):
// { personId, deceased, email, phone: { phone, cell } | null,
//   donor: { lglConstituentId, lastGiftDate } | null,
//   detail: { firstName, lastName, suffix, nickname, street, unit, city, state, zip, deceasedDate } }

// FieldValues, produced for either side:
// { firstName, lastName, suffix, nickname, email, phone, cell: string | null,
//   address: { street, unit, city, state, zip } | null,
//   deceased: { flag: boolean, date: string | null } }
```

---

### Task 1: Project shell and configuration

**Files:**
- Create: `package.json`, `.env.example`, `.github/workflows/test.yml`, `src/lgl-vg/config.js`
- Test: `test/lgl-vg/config.test.js`

**Interfaces:**
- Produces: `loadConfig(env = process.env) -> Config`, where
  `Config = { lgl: { apiKey, membershipFundId: number, paypalPaymentTypeId: number }, vg: { apiUrl, oidcUrl, clientId, clientSecret, scope }, createHorizonYears: number }`.

- [ ] **Step 1: Write `package.json`**

`name: "vg-sync"`, `private: true`, `type: "module"`, `engines.node: ">=24"`, scripts `"test": "node --test"` and `"report": "node src/lgl-vg/main.js report"`. No dependencies.

- [ ] **Step 2: Write `.env.example`**

```
LGL_API_KEY=
LGL_MEMBERSHIP_FUND_ID=
LGL_PAYPAL_PAYMENT_TYPE_ID=
VG_API_URL=
VG_OIDC_URL=
VG_CLIENT_ID=
VG_CLIENT_SECRET=
VG_SCOPE=vg
CREATE_HORIZON_YEARS=5
```

- [ ] **Step 3: Write the failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../../src/lgl-vg/config.js'

const full = {
  LGL_API_KEY: 'k', LGL_MEMBERSHIP_FUND_ID: '11', LGL_PAYPAL_PAYMENT_TYPE_ID: '22',
  VG_API_URL: 'https://vg.example.org/api/', VG_OIDC_URL: 'https://auth.example.org/realms/vg/',
  VG_CLIENT_ID: 'vg-sync', VG_CLIENT_SECRET: 's',
}

test('loadConfig reads values, converts ids to numbers, strips trailing slashes, applies defaults', () => {
  const c = loadConfig(full)
  assert.deepEqual(c.lgl, { apiKey: 'k', membershipFundId: 11, paypalPaymentTypeId: 22 })
  assert.equal(c.vg.apiUrl, 'https://vg.example.org/api')
  assert.equal(c.vg.oidcUrl, 'https://auth.example.org/realms/vg')
  assert.equal(c.vg.scope, 'vg')
  assert.equal(c.createHorizonYears, 5)
})

test('loadConfig names every missing variable in one error', () => {
  const { LGL_API_KEY, VG_CLIENT_SECRET, ...rest } = full
  assert.throws(() => loadConfig(rest), /LGL_API_KEY.*VG_CLIENT_SECRET/s)
})

test('loadConfig rejects a non-numeric fund id and a non-https URL', () => {
  assert.throws(() => loadConfig({ ...full, LGL_MEMBERSHIP_FUND_ID: 'x' }), /LGL_MEMBERSHIP_FUND_ID/)
  assert.throws(() => loadConfig({ ...full, VG_API_URL: 'http://vg.example.org/api' }), /VG_API_URL/)
})

test('loadConfig allows http for localhost', () => {
  assert.equal(loadConfig({ ...full, VG_API_URL: 'http://localhost:64001/api' }).vg.apiUrl, 'http://localhost:64001/api')
})
```

- [ ] **Step 4: Run it and see it fail**

Run: `node --test test/lgl-vg/config.test.js` — expected: FAIL, cannot find module.

- [ ] **Step 5: Implement `loadConfig` in `src/lgl-vg/config.js`**

- [ ] **Step 6: Write `.github/workflows/test.yml`**

Copy the shape of `~/dev/tvcri/vg-email-sidecar/.github/workflows/test.yml`: trigger `pull_request`, `permissions: contents: read`, checkout v4, setup-node v4 with `node-version: 24`, then `npm test`. There is no lockfile, so no `npm ci` and no npm cache.

- [ ] **Step 7: Run the tests, then commit**

Run: `npm test` — expected: PASS. Commit: `Step 1: project shell and configuration`.

---

### Task 2: LGL client

**Files:**
- Create: `src/lgl-vg/lgl.js`
- Test: `test/lgl-vg/lgl.test.js`

**Interfaces:**
- Produces: `createLglClient({ apiKey, fetchImpl = fetch, sleep, baseUrl }) -> { pullConstituents(): Promise<object[]>, pullGifts(): Promise<object[]> }`.
  `pullConstituents` calls `/constituents/search` with `expand=email_addresses,street_addresses,phone_numbers`; `pullGifts` calls `/gifts/search`.

Port `~/dev/tvcri/vg-utils/lgl-import/src/lgl.js` (65 lines) with two changes: expose only the two methods above, and replace the retry policy as below. Use the fake-fetch pattern from `~/dev/tvcri/vg-utils/lgl-cleanup/test/lgl.test.js` lines 5-17 (routes keyed `"METHOD path?query"`, arrays of responses for retries, `sleep` injected).

Retry policy: on 429 or any 5xx, wait `Retry-After` seconds when the header is a positive number; otherwise wait 30 s, 60 s, 120 s, 240 s on successive attempts. Give up after 5 attempts (four waits, 450 s in total without the header).

- [ ] **Step 1: Write the failing tests**

```js
test('sends Basic auth with the key as user and an empty password')
// assert headers.Authorization === 'Basic ' + Buffer.from('k:').toString('base64')

test('pullConstituents pages by 1000 and asks for the three sub-lists')
// two pages (1000 + 1 items, total_items 1001) -> 1001 items;
// first URL has limit=1000&offset=0 and expand=email_addresses,street_addresses,phone_numbers

test('throws when the pages add up to fewer than total_items')
// total_items 5, one page of 3 then an empty page -> rejects /Incomplete read/

test('waits out Retry-After on 429')
// responses [429 with retry-after: 7, 200]; sleeps recorded === [7000]

test('with no Retry-After, backs off 30, 60, 120, 240 seconds, then fails')
// five 503 responses -> rejects /503/; sleeps === [30000, 60000, 120000, 240000]

test('a 4xx other than 429 fails at once with the status and path')
// 403 -> rejects /LGL GET \/gifts\/search.*403/; no sleeps
```

- [ ] **Step 2: Run and see them fail** — `node --test test/lgl-vg/lgl.test.js`
- [ ] **Step 3: Implement `createLglClient`**
- [ ] **Step 4: Run and see them pass**
- [ ] **Step 5: Commit** — `Step 1: read-only LGL client`

---

### Task 3: VG client

**Files:**
- Create: `src/lgl-vg/vg.js`
- Test: `test/lgl-vg/vg.test.js`

**Interfaces:**
- Consumes: `Config.vg` from Task 1.
- Produces: `createVgClient({ apiUrl, oidcUrl, clientId, clientSecret, scope, fetchImpl = fetch, now = Date.now }) -> { whoAmI(): Promise<object>, listPersons(): Promise<Person[]> }`.

Behavior:
- Token: `POST {oidcUrl}/protocol/openid-connect/token`, body `application/x-www-form-urlencoded` with `grant_type=client_credentials`, `client_id`, `client_secret`, `scope`. Cache `access_token` until 30 s before `expires_in`.
- Every API call sends `Authorization: Bearer <token>`. On a 401, discard the token, fetch a new one and retry once.
- `whoAmI` is `GET {apiUrl}/user`. `listPersons` is `GET {apiUrl}/persons?projection=detail` and returns the array.
- `listPersons` throws `Error('The service account cannot read donors (donor:read is missing)')` when the array is non-empty and no element has an own property `donor`. (The API omits the property entirely for callers without the permission; `donor: null` means "not a donor".)
- A non-2xx answer throws `VG <METHOD> <path> → <status>: <first 200 chars of body>`.
- A 403 appends to that message: ` (check that the service account has a role grant, a privacy acknowledgement, and the scope in VG_SCOPE)`. Those are the three setup steps a new service account needs, and the API answers 403 for each.

- [ ] **Step 1: Write the failing tests**

```js
test('fetches a token with the client-credentials form and sends it as Bearer')
test('reuses the token until 30 seconds before it expires, then fetches another')
// expires_in 300; calls at now=0 and now=269000 -> one token request; a call at now=271000 -> two
test('on 401 fetches a new token and retries once; a second 401 throws')
test('listPersons asks for projection=detail and returns the array')
test('listPersons throws when no person carries a donor property')
// [{ personId: 1, detail: {} }] -> rejects /donor:read/
test('listPersons accepts donor: null')
// [{ personId: 1, donor: null, detail: {} }] -> resolves
test('a 403 from the API mentions the role grant, the privacy acknowledgement and the scope')
test('a token endpoint failure names Keycloak, not the API')
// 401 from the token URL -> rejects /Keycloak token/
```

- [ ] **Step 2: Run and see them fail**
- [ ] **Step 3: Implement `createVgClient`**
- [ ] **Step 4: Run and see them pass**
- [ ] **Step 5: Commit** — `Step 1: VG client with service-account sign-in`

---

### Task 4: Donor rule

**Files:**
- Create: `src/lgl-vg/donors.js`
- Test: `test/lgl-vg/donors.test.js`

**Interfaces:**
- Produces: `classifyDonors(constituents, gifts, { membershipFundId, paypalPaymentTypeId }) -> Map<constituentId, { isDonor: boolean, lastGiftDate: string | null }>`, with an entry for every constituent passed in.

Rules (source: `~/dev/tvcri/vg-utils/lgl-import/count.js` lines 14-19 and 91-103):
- A gift counts unless `gift_type_id` is 7, 9 or 15 (Pledge, Soft Credit, Peer Credit).
- A counting gift is dues when `fund_id === membershipFundId && payment_type_id === paypalPaymentTypeId`.
- `isDonor` is true when the constituent is not an organization (`is_org` falsy) and has at least one counting gift that is not dues.
- `lastGiftDate` is the greatest `received_date` among counting non-dues gifts, ignoring nulls; null if there is none. Dates are `YYYY-MM-DD` strings and compare as strings.

- [ ] **Step 1: Write the failing tests**

```js
const ids = { membershipFundId: 11, paypalPaymentTypeId: 22 }
const gift = (constituent_id, o = {}) => ({ constituent_id, gift_type_id: 1, fund_id: 5, payment_type_id: 9, received_date: '2026-01-10', ...o })

test('one ordinary gift makes a donor with that date')
test('dues only (membership fund paid by PayPal) is not a donor')
test('PayPal to another fund counts; the membership fund paid by check counts')
test('pledge, soft credit and peer credit (types 7, 9, 15) never count')
test('an organization is never a donor')
test('last gift date is the latest non-dues date; a later dues payment does not move it')
// gifts 2025-03-01 (ordinary), 2026-02-01 (dues) -> lastGiftDate '2025-03-01'
test('a null received_date is ignored; a donor whose only gifts have no date has lastGiftDate null')
test('a constituent with no gifts gets { isDonor: false, lastGiftDate: null }')
```

- [ ] **Step 2: Run and see them fail**
- [ ] **Step 3: Implement `classifyDonors`**
- [ ] **Step 4: Run and see them pass**
- [ ] **Step 5: Commit** — `Step 1: donor rule and last gift date`

---

### Task 5: Cleaning and field values

**Files:**
- Create: `src/lgl-vg/clean.js`, `src/lgl-vg/fields.js`
- Test: `test/lgl-vg/clean.test.js`, `test/lgl-vg/fields.test.js`

**Interfaces:**
- Produces, from `clean.js`: `splitStreet(raw) -> { street, unit, omitted: string[] }`, `stateCode(s) -> string | null`, `formatPhone(entry) -> string | null`, `cleanName(s) -> string` (ported from `~/dev/tvcri/vg-utils/lgl-import/src/person.js`: `splitStreet` 48-66, `formatPhone` 69-76, `stateCode` 80-98, and the name rule at 102-128).
- Produces, from `fields.js`:
  - `FIELDS: string[]`, the nine names in the order given under Global Constraints.
  - `lglFields(constituent) -> { values: FieldValues, entryIds: { address, email, phone, cell: number | null }, problems: { [field]: 'unclean' | 'ambiguous' } }`
  - `vgFields(person) -> FieldValues`
  - `comparable(field, value) -> string`

`lglFields` rules:
- Names: `first_name`, `last_name`, `suffix`, `nick_name`, each through `cleanName`; empty becomes null.
- For each list, consider only entries where `not_current` is falsy. Phones split into mobile (`phone_type_name` matches `/mobile|cell/i`) for `cell` and the rest for `phone`.
- The entry used is the one with `is_preferred` true. If none is preferred and exactly one is current, use that one. If none is preferred and more than one is current, the field's value is null and `problems[field] = 'ambiguous'`.
- Address: street through `splitStreet`; state through `stateCode`; ZIP from `zip5 || postal_code`, must match `^\d{5}(-?\d{4})?$`, reduced to five digits; city through `cleanName`. If street, city, state or ZIP is missing or invalid, or the city contains a digit, the value is null and `problems.address = 'unclean'`.
- Email: trimmed; must match `/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i`, otherwise null and `problems.email = 'unclean'`.
- Phone and cell: `formatPhone`; null result with an entry present is `'unclean'`.
- Deceased: `{ flag: Boolean(is_deceased), date: deceased_date ?? null }`.

`vgFields` reads `detail.firstName/lastName/suffix/nickname`, the root `email`, `phone.phone`, `phone.cell`, `detail.street/unit/city/state/zip` (address is null when `street` is empty), and `{ flag: person.deceased, date: detail.deceasedDate ?? null }`. Empty strings become null.

`comparable` rules. Null or empty gives `''`. Text is normalized by: NFD, strip combining marks, lowercase, remove `. , ' ( ) -`, collapse spaces, trim.
- `firstName`: drop any parenthetical first (`"Robert (Bob)"` compares as `robert`), then normalize.
- `lastName`, `suffix`, `nickname`: normalize.
- `email`: trim and lowercase only.
- `phone`, `cell`: digits only, last ten.
- `deceased`: `'0'` when the flag is false; `'1|' + (date ?? '')` when true.
- `address`: normalize each part; in the street, replace whole words using this table, then join as `street|unit|city|state|zip5`.
  `street→st, avenue→ave, road→rd, drive→dr, lane→ln, court→ct, place→pl, boulevard→blvd, terrace→ter, circle→cir, highway→hwy, parkway→pkwy, north→n, south→s, east→e, west→w`.
  In the unit, drop the words `apt, apartment, unit, suite, ste` and the character `#`.

- [ ] **Step 1: Write the failing tests for `clean.js`**

Port the `splitStreet`, `formatPhone` and `stateCode` cases from `~/dev/tvcri/vg-utils/lgl-import/test/import.test.js`, keeping their invented fixtures, and add:

```js
test('cleanName title-cases a name typed in one case and leaves mixed case alone', () => {
  assert.equal(cleanName('JANE'), 'Jane')
  assert.equal(cleanName('doe'), 'Doe')
  assert.equal(cleanName('McDoe'), 'McDoe')
  assert.equal(cleanName('  Doe ,'), 'Doe')
})
```

- [ ] **Step 2: Write the failing tests for `fields.js`**

```js
const addr = (o = {}) => ({ id: 1, street: '12 Elm Street', city: 'Providence', state: 'RI', postal_code: '02903', is_preferred: true, not_current: false, ...o })

test('a constituent with no lists and null optional fields yields empty values and no problems')
// lglFields({ id: 7, first_name: 'Jane', last_name: 'Doe' }) -> address/email/phone/cell null, problems {}

test('the preferred current entry is used, and its id recorded')
// two addresses, second preferred -> values.address.street '34 Oak Ave', entryIds.address === second id

test('a not_current preferred entry is ignored')
test('one current entry with none preferred is used')
test('two current entries with none preferred is ambiguous')
// problems.address === 'ambiguous', values.address === null

test('a spelled-out state and ZIP+4 are cleaned')
// state 'Rhode Island', zip5 '02903', postal_code '02903-1234' -> { state: 'RI', zip: '02903' }

test('an address with no city is unclean')
test('an email without a domain is unclean')
test('mobile goes to cell, other types to phone')
test('vgFields maps the API person and turns empty strings into null')

test('comparable ignores case, accents, punctuation and street-word spelling', () => {
  const a = { street: '12 Elm Street', unit: 'Apt 2', city: 'Providence', state: 'RI', zip: '02903' }
  const b = { street: '12 ELM ST.', unit: '#2', city: 'providence', state: 'RI', zip: '02903' }
  assert.equal(comparable('address', a), comparable('address', b))
  assert.equal(comparable('firstName', 'Robert (Bob)'), comparable('firstName', 'ROBERT'))
  assert.equal(comparable('lastName', 'Doé'), comparable('lastName', 'doe'))
  assert.equal(comparable('phone', '(401) 555-0100'), comparable('phone', '401-555-0100'))
  assert.equal(comparable('email', ' Jane@Example.org '), 'jane@example.org')
})

test('comparable tells real differences apart', () => {
  assert.notEqual(comparable('address', { street: '12 Elm St', unit: null, city: 'Providence', state: 'RI', zip: '02903' }),
                  comparable('address', { street: '14 Elm St', unit: null, city: 'Providence', state: 'RI', zip: '02903' }))
  assert.notEqual(comparable('deceased', { flag: true, date: '2026-01-01' }), comparable('deceased', { flag: true, date: null }))
  assert.equal(comparable('deceased', { flag: false, date: null }), '0')
  assert.equal(comparable('email', null), '')
})
```

- [ ] **Step 3: Run and see them fail**
- [ ] **Step 4: Implement `clean.js`, then `fields.js`**
- [ ] **Step 5: Run and see them pass**
- [ ] **Step 6: Commit** — `Step 1: cleaning, field values and comparable form`

---

### Task 6: Three-way comparison

**Files:**
- Create: `src/lgl-vg/compare.js`
- Test: `test/lgl-vg/compare.test.js`

**Interfaces:**
- Produces: `compareField(lgl: string, vg: string, agreed: string | undefined) -> Case`, where the arguments are comparable forms and `Case` is one of `'same' | 'first-match' | 'converged' | 'lgl-changed' | 'vg-changed' | 'lgl-cleared' | 'vg-cleared' | 'both-changed' | 'never-agreed'`.

Step 1 always passes `agreed` as `undefined`, so the report sees only `first-match` and `never-agreed`. The full table is built now because it is nine lines and the later steps depend on it.

- [ ] **Step 1: Write the failing test**

```js
const cases = [
  ['a', 'a', undefined, 'first-match'],
  ['',  '',  undefined, 'first-match'],
  ['a', 'b', undefined, 'never-agreed'],
  ['a', '',  undefined, 'never-agreed'],
  ['a', 'a', 'a', 'same'],
  ['b', 'b', 'a', 'converged'],
  ['b', 'a', 'a', 'lgl-changed'],
  ['a', 'b', 'a', 'vg-changed'],
  ['',  'a', 'a', 'lgl-cleared'],
  ['a', '',  'a', 'vg-cleared'],
  ['b', 'c', 'a', 'both-changed'],
  ['',  'c', 'a', 'both-changed'],
  ['',  '',  'a', 'converged'],
]
for (const [lgl, vg, agreed, want] of cases) {
  test(`lgl=${JSON.stringify(lgl)} vg=${JSON.stringify(vg)} agreed=${JSON.stringify(agreed)} -> ${want}`, () => {
    assert.equal(compareField(lgl, vg, agreed), want)
  })
}
```

- [ ] **Step 2: Run and see it fail**
- [ ] **Step 3: Implement `compareField`**
- [ ] **Step 4: Run and see it pass**
- [ ] **Step 5: Commit** — `Step 1: three-way field comparison`

---

### Task 7: Matching unlinked donors

**Files:**
- Create: `src/lgl-vg/match.js`
- Test: `test/lgl-vg/match.test.js`

**Interfaces:**
- Consumes: `lglFields` from Task 5 (for the donor's email and address).
- Produces: `matchUnlinked(donors, persons, { today, horizonYears }) -> Decision[]`, where
  `donors = [{ constituent, lastGiftDate }]` (unlinked person-donors only),
  `persons` is the VG array, `today` is `YYYY-MM-DD`, and
  `Decision = { constituentId, outcome: 'link' | 'create' | 'hold', reason: string, personId?: number }`.

Port the normalization and indexes from `~/dev/tvcri/vg-utils/lgl-import/count.js` lines 41-66 (`norm`, `firstNames`, `nameKeys`, `emailKey`, `addrKey`, `isCoupleRecord`) and `nearDuplicates` from `src/suggest.js` lines 76-91 with its helpers (`NICK`, `lev`, `sameFirst`). A VG person's first names are its `detail.firstName` with any parenthetical removed, the parenthetical itself, and `detail.nickname`.

Decide each donor in this order; the first rule that applies wins. `E` is the set of VG people sharing any of the donor's current emails; `N` is the set matching any of the donor's name keys; `EN` is their intersection.

| # | Condition | Outcome | Reason |
|---|---|---|---|
| 1 | first or last name matches `/\banonymous\b/i` | hold | `anonymous` |
| 2 | `is_deceased` | hold | `deceased-in-lgl` |
| 3 | `isCoupleRecord` | hold | `couple-name` |
| 4 | `EN` has one person, already a donor under a different constituent id | hold | `already-linked-elsewhere` |
| 5 | `EN` has one person | link (`personId`) | `email-and-name` |
| 6 | `EN` has more than one | hold | `multiple-matches` |
| 7 | `E` is not empty | hold | `shared-email-different-name` |
| 8 | `N` is not empty | hold | `name-only` |
| 9 | a VG person has the same last name and the same house number and ZIP | hold | `same-address-last-name` |
| 10 | no last name | hold | `no-last-name` |
| 11 | `lastGiftDate` is null or earlier than `today` minus `horizonYears` | hold | `before-horizon` |
| 12 | otherwise | create | `new` |

Then two passes over the decisions:
- Any `personId` that two or more `link` decisions share: all of them become `hold`, reason `duplicate-in-lgl`.
- Any `create` decisions whose donors `nearDuplicates` groups together, or whose normalized first and last names are equal: all of them become `hold`, reason `duplicate-in-lgl`.

- [ ] **Step 1: Write the failing tests**

One test per row of the table, named for its reason, each with the smallest invented donor and VG roster that triggers it, plus:

```js
test('matches the VG parenthetical nickname: LGL "Bob Doe" links to VG "Robert (Bob)" with the same email')
test('matches the VG nickname field')
test('a shared household email with a different name is held, not linked')
test('two LGL donors that link to the same VG person are both held as duplicate-in-lgl')
test('two new LGL donors with the same name are both held as duplicate-in-lgl')
test('a donor exactly on the horizon is created; one day older is held')
// today '2026-11-11', horizonYears 5: lastGiftDate '2021-11-11' -> create; '2021-11-10' -> hold before-horizon
test('an "is_anon" donor with a real name is not treated as anonymous')
test('a not_current email is not used for matching')
```

- [ ] **Step 2: Run and see them fail**
- [ ] **Step 3: Implement `matchUnlinked`**
- [ ] **Step 4: Run and see them pass**
- [ ] **Step 5: Commit** — `Step 1: matching of unlinked donors`

---

### Task 8: The report

**Files:**
- Create: `src/lgl-vg/report.js`
- Test: `test/lgl-vg/report.test.js`

**Interfaces:**
- Consumes: `classifyDonors` (Task 4), `FIELDS`, `lglFields`, `vgFields`, `comparable` (Task 5), `compareField` (Task 6), `matchUnlinked` (Task 7).
- Produces: `buildReport({ constituents, gifts, persons, config, today }) -> { summary, details }`.

```js
// summary
{
  counts: { constituents, gifts, personDonors, vgPersons, linkedPairs, couples,
            linkedMissingInLgl, linkedNoLongerDonor, unlinkedDonors },
  fields: { [field]: { 'first-match': n, 'never-agreed': n, unclean: n, ambiguous: n, 'couple-skipped': n } },
  lastGiftDate: { same: n, differs: n },
  unlinked: { link: n, create: n, hold: { [reason]: n } },
}
// details: one object per line of the detail file
{ kind: 'field', personId, constituentId, field, lgl, vg }            // every never-agreed, unclean or ambiguous field
{ kind: 'lastGiftDate', personId, constituentId, lgl, vg }            // where they differ
{ kind: 'unlinked', constituentId, outcome, reason, personId }        // every decision
{ kind: 'linked-missing' | 'linked-no-longer-donor', personId, constituentId }
```

Rules:
- A linked pair is a VG person with `donor !== null` whose `donor.lglConstituentId` (a string) equals a pulled constituent's `id` (compare as strings).
- If the constituent is absent from the pull: count `linkedMissingInLgl`, emit `linked-missing`, compare nothing.
- If present but `isDonor` is false: count `linkedNoLongerDonor`, emit `linked-no-longer-donor`, and still compare fields.
- A couple is a constituent linked from two or more people; `couples` counts constituents. For a couple, `firstName`, `lastName`, `suffix`, `nickname` and `deceased` are not compared and add to `couple-skipped`; the other fields are compared for each partner.
- A field with a problem adds to `unclean` or `ambiguous` and is not compared.
- Otherwise `compareField(comparable(f, lgl), comparable(f, vg), undefined)`.
- `lastGiftDate` compares `classifyDonors`'s date with `donor.lastGiftDate` as strings, null equal to null.
- Unlinked donors are person-donors whose id no VG person links to; pass them to `matchUnlinked` with `config.createHorizonYears`.

- [ ] **Step 1: Write the failing tests**

Build one small invented world in the test file (four constituents, a handful of gifts, five VG people) and assert on it:

```js
test('counts linked pairs, couples and unlinked donors')
test('a matching field is first-match; a differing one is never-agreed and appears in details with both values')
test('a couple skips names and deceased for both partners and compares address for each')
test('an unclean LGL address is counted as unclean and not compared')
test('a donor row pointing at a constituent not in the pull is counted and listed, and compared nowhere')
test('a linked constituent that is no longer a donor is counted and still compared')
test('last gift date differences are counted and listed')
test('constituent ids compare as strings: VG "17" links to LGL 17')
test('summary contains no names, emails, addresses or phone numbers')
// JSON.stringify(summary) must not include any fixture name, email or street
```

- [ ] **Step 2: Run and see them fail**
- [ ] **Step 3: Implement `buildReport`**
- [ ] **Step 4: Run and see them pass**
- [ ] **Step 5: Commit** — `Step 1: report over linked pairs and unlinked donors`

---

### Task 9: Command line

**Files:**
- Create: `src/lgl-vg/main.js`
- Modify: `README.md` (add a "Running the report" section)
- Test: `test/lgl-vg/main.test.js`

**Interfaces:**
- Consumes: `loadConfig`, `createLglClient`, `createVgClient`, `buildReport`.
- Produces: `run(argv, { env, fetchImpl, now, stdout, writeFile, readFile }) -> Promise<number>` (the exit code), and a last line in the file that calls it with the real ones when the file is the entry point.

Behavior of `main.js report`:
- Options: `--out <dir>` (default `out`), `--save-snapshot` (write the LGL pull to `<out>/lgl-snapshot-<timestamp>.json`), `--snapshot <file>` (read LGL data from that file and make no LGL request).
- Loads `.env` from the working directory with `process.loadEnvFile` if the file exists; then `loadConfig`.
- Calls `whoAmI` first, so a sign-in problem fails before the 95-second LGL pull.
- Pulls LGL (or reads the snapshot), reads VG, builds the report with `today` taken from `now`.
- Writes details to `<out>/report-<timestamp>.jsonl`, one JSON object per line.
- Prints the summary to standard output as indented JSON, followed by one line naming the detail file.
- Returns 0. On any error prints `REPORT FAILED: <message>` and returns 1.
- Any first argument other than `report` prints usage and returns 2.
- Timestamps in file names are ISO with `:` and `.` replaced by `-`.

- [ ] **Step 1: Write the failing tests**

```js
test('report signs in, pulls both systems, prints the summary and writes the detail file')
// fake fetch serving the token, /user, /persons, /constituents/search, /gifts/search;
// returns 0; stdout parses as JSON up to the last line; writeFile called once with a path under out/ ending .jsonl

test('report with --snapshot makes no request to LGL')
// fake fetch throws on any littlegreenlight URL; readFile returns { constituents, gifts }

test('report with --save-snapshot writes the pull under out/')
test('a sign-in failure returns 1, prints REPORT FAILED, and never calls LGL')
test('standard output contains no fixture name, email or street')
test('an unknown command returns 2')
```

- [ ] **Step 2: Run and see them fail**
- [ ] **Step 3: Implement `run` and the entry-point line**
- [ ] **Step 4: Add the README section**

State: what the report does and that it writes nothing to LGL or VG; the `.env` variables (by name, pointing at `.env.example`); that the service account needs the Keycloak client and the Staff role on the target VG; the three invocations (`npm run report`, with `--save-snapshot`, with `--snapshot <file>`); that the detail file under `out/` holds real people and must not be committed or shared.

- [ ] **Step 5: Run the whole suite**

Run: `npm test` — expected: every test passes, no network access.

- [ ] **Step 6: Commit** — `Step 1: report command`

---

### Task 10: Service-account setup command

A restored production snapshot does not contain the service account, so after every restore (until the account exists in production) it has no user row, no role and no privacy acknowledgement. The API creates the user row on the account's first request. A person grants the role in VG. Only the account itself can record its acknowledgement. This command does the two parts the account must do and says plainly what a person must do in between.

**Files:**
- Modify: `src/lgl-vg/vg.js`, `src/lgl-vg/main.js`, `README.md`
- Test: `test/lgl-vg/vg.test.js`, `test/lgl-vg/main.test.js`

**Interfaces:**
- Produces, on the VG client: `privacyStatus(): Promise<object>` (`GET {apiUrl}/user?projection=privacyStatus`, returning the `privacyStatus` object), `currentPrivacyRules(): Promise<object>` (`GET {apiUrl}/privacy/rules`), `acknowledgePrivacy(rulesId: number): Promise<object>` (`POST {apiUrl}/privacy/acknowledgements` with body `{ rulesId }`).
- Read the `PrivacyStatus`, privacy rules and `PrivacyAcknowledgementPost` schemas in `~/dev/village-green/api/source/specification/village-green.yaml` for the exact property that says an acknowledgement is owed and the property that carries the current rules id. Use them as named there.

Behavior of `main.js setup [--acknowledge-privacy]`, in order, stopping at the first step that is not satisfied:

1. Sign in and call `whoAmI`. Print `Signed in as <username> (user id <id>)`. This call also creates the user row if it did not exist.
2. If an acknowledgement is owed: without the flag, print `Privacy acknowledgement is owed. Run again with --acknowledge-privacy.` and return 1. With the flag, read the current rules, post the acknowledgement, print `Privacy acknowledgement recorded.`
3. Call `listPersons`. On a 403, print `<username> has no role grant. Grant it the Staff role at federation level in VG, then run setup again.` and return 1. On the `donor:read` error from Task 3, print that message and return 1.
4. Print `SETUP OK` and return 0.

- [ ] **Step 1: Write the failing tests**

```js
test('acknowledgePrivacy posts { rulesId } to /privacy/acknowledgements')
test('setup prints who it signed in as')
test('setup stops at an owed acknowledgement when the flag is absent, and posts nothing')
test('setup with --acknowledge-privacy reads the rules and posts their id')
test('setup reports a missing role grant on 403 from /persons and returns 1')
test('setup prints SETUP OK when nothing is owed and persons can be read')
```

- [ ] **Step 2: Run and see them fail**
- [ ] **Step 3: Implement the three client methods and the `setup` command**
- [ ] **Step 4: Add a "Setting up the service account" section to the README**

Give the sequence for a freshly restored database: run `setup`; grant the Staff role to the name it prints; run `setup --acknowledge-privacy`; run the report. Say that this is needed again after each restore until the account exists in production.

- [ ] **Step 5: Run the whole suite, then commit** — `Step 1: service-account setup command`

---

## After the last task

The engineer, not the implementer, runs the report against a VG API on a restored snapshot and the live LGL (read-only). Its numbers answer the go-live question in the spec ("where the two systems already disagree") and are the check on the comparison and matching rules before anything writes.
