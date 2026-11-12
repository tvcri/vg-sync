# Mailchimp findings, 2026-11-11

What the hand-run VG → Mailchimp work in `~/dev/tvcri/mailchimp-poc` learned
between 2026-07 and 2026-11, for whoever designs the VG → Mailchimp executable.
It adds to the Mailchimp notes in `context-2026-11-11.md` and doesn't repeat them.
It is findings, not a design. Counts are as of 2026-11-11 and will drift.

The private detail is in `mailchimp-poc`: `HANDOFF.md`,
`docs/mailchimp-account-reference.md` (§7.3 lists every write ever made to the
account), and the per-run logs in `snapshots/`. Those name real people. Nothing
here does, and nothing copied from there should.

## The account, in numbers

| | 2026-11-11 |
|---|---|
| Subscribed | 4,440 |
| Cleaned (hard bounced) | ~640, growing 5–20 a month |
| Unsubscribed | ~100 |
| Archived | ~790+ (cannot be counted, see below) |
| Billable, Essentials plan | 4,537 of 5,000 |

- **Billable is subscribed + unsubscribed.** Cleaned and archived contacts are
  not billed. That is why ~790 unsubscribed contacts were archived in July 2026:
  it cleared an overage. The tooling computes billable as
  `stats.member_count + stats.unsubscribe_count`.
- **Merge fields: only `FNAME` and `LNAME`.** There is no member-type, village or
  VG-id field. Any targeting or matching that needs one means creating a field,
  which the customer's mailing designer will see. That is a customer decision.
- The account also holds a second audience belonging to the outside designer,
  with double opt-in and its own campaign history. Never write to it, even for
  staging.

## Mailchimp API behaviour, verified against this account

1. **Archived contacts can't be listed, but can be read by address.**
   `GET /lists/{id}/archived-members` returns 404, and `/members` omits archived
   contacts. `GET /lists/{id}/members/{subscriber_hash}` returns 200 with
   `status: "archived"` and their tags intact. When you start from candidate
   addresses (from VG), you never need to list archived contacts: look each
   absent one up by hash. Opt-outs are then detected from live data, not from a
   snapshot that goes stale.
2. **PUT on an archived contact returns 200 and does nothing**: empty `detail`,
   still archived. A 2xx doesn't prove the write happened. Read the status back
   after every write (the existing tool does).
3. **`status_if_new: "subscribed"`** sets status only when the contact is
   created, so re-running never resubscribes an unsubscribed or cleaned contact.
   Upserts are idempotent.
4. **There is no reliable archived count.** The list `stats` don't include it,
   and `stats.total_contacts` doesn't exist on this API version. An early
   version did arithmetic on it, got a negative count, and would have skipped the
   archived lookups in production. Don't do arithmetic on fields you haven't
   confirmed exist.
5. **The one safe shortcut**: a list with `member_count`, `unsubscribe_count`,
   `cleaned_count` and `campaign_count` all zero has never had a contact to
   archive, so a fresh staging list can skip the per-address lookups. Nothing
   else qualifies.
6. **Contacts are keyed by the MD5 of the lowercased address.** VG stores
   addresses with mixed case. Lowercase and trim before hashing and comparing.
7. **An address with no `@` is rejected (400).** A typo in the domain
   (`.con`, `veriozn.net`) is accepted, then bounces and becomes cleaned, which
   costs sending reputation. Both kinds were found in VG data.
8. **Tags are "static segments" in the API.** The UI says "tag" and reserves
   "segment" for rule-based saved segments, of which this account has one. Use
   UI terms in anything the customer reads.
9. **"Pasted emails" send-to** (the campaign checklist) targets a pasted list
   of subscribed addresses with no tag or segment write. It is documented, but
   whether the pasted list is stored, and any size cap, are untested.
10. Pacing: the tool waits 300 ms between writes and makes one GET per absent
    candidate. About 80 lookups per run was normal.

## Tags: not authoritative, and rarely used

- **Tags only accumulate.** The import wizard, the existing syncs and staff all
  add; nothing ever removes. In July 2026, 536 contacts tagged `Member` were no
  longer members.
- **`Donor` is a superset**: every subscribed LGL donor as of 2026-11-02, plus
  whoever already had it. `Volunteer` hasn't been maintained since 2020 and
  covered under 10% of active volunteers in September 2026. Village tags exist
  for 4 of 13 villages and are one-off imports.
- **The newsletter has gone to the whole audience since July 2020**, and staff
  were told on 2026-11-11 to send to the full list, not to a tag. So tags
  barely matter for delivery today. That is also why "tags are wrong" is low
  stakes and "who is on the list" is high stakes.
- Whether the executable writes tags, which ones, and whether it removes them
  is open for the customer (the brief parks it). Removing tags is the only way
  they become trustworthy, and also the first thing this account has never done.
- A Circle of Pride delivery mystery from 2024–26 is closed, with the support
  case handed to the customer. Don't reopen it as analysis.

## Who is on the list: the cohort used

```sql
SELECT personId FROM active_member
UNION SELECT personId FROM active_volunteer
UNION SELECT d.personId FROM donor d JOIN person p ON p.id = d.personId WHERE p.deceased = 0
```

- The views already exclude the deceased. The `donor` table has no status, so
  that leg checks `deceased` itself, the same rule as VG's mailing labels.
- **No last-gift cutoff.** Anyone VG holds as a donor is included, the same as
  the 2026-11-02 LGL-sourced run. Whether lapsed donors should be mailed is a
  customer question if anyone raises it.
- Deduplicated to one contact per lowercased address, and the first person's
  name wins (couples share an address; about 25 cases). About 1,730 people give
  about 1,470 candidate addresses; about 225 people have no address.
- The 11-11 run: about 1,360 already subscribed, 6 added, about 106 skipped
  (72 archived, 16 cleaned, 18 unsubscribed). Once the backlog is cleared, each
  run adds a handful of people.

## VG data quirks that matter to Mailchimp

- **`person.emailStatus` is not evidence.** It came from the ClubExpress
  import, nothing in VG maintains it, and nobody knows why an address was
  flagged. Of the five addresses flagged `Bad Address`, two were subscribed and
  receiving mail. The sync stopped reading it on 2026-11-11, and removing the
  column from the schema is a separate job. Mailchimp's own cleaned status is
  the signal that an address bounces.
- **Bad addresses do exist**: missing `@`, wrong top-level domain, misspelled
  domain. Checking syntax and holding the bad ones for staff is cheap.
  Auto-correcting is not the engineer's call.
- **Duplicate people exist**: the same person in two villages, one record
  Dropped and one Active, with the same address. Deduplicating by address hides
  it from Mailchimp. Resolving it belongs to the customer, in the app.
- **When an email changes in VG, the old address stays subscribed.** Every
  sync so far only adds: a corrected address becomes a new contact, and the old
  contact stays. That's harmless when the old one had bounced (the case so far),
  but for a live old address it means two copies and two billable contacts.
  Fixing it needs to know which Mailchimp contact is which VG person. Nothing
  records that today: no VG id in Mailchimp, and no table in VG. This is the
  main design question for the update/remove phase. (Mailchimp's member PATCH
  is documented as able to change `email_address`. That has not been verified
  on this account.)

## Never delete contacts from Mailchimp

Staff asked once to "delete the bad emails" (the cleaned list). The answer, and
the reasoning the service should keep:

- **Cleaned contacts cost nothing and are never sent to.**
- **Deleting one makes Mailchimp forget it bounced.** The next sync would see
  the address in VG as new and add it, and it would bounce again. Archiving is
  safe (the hash lookup sees `archived` and skips it), but it gains nothing.
- **The useful action is fixing the address in VG.** On 2026-11-11 the work
  listed the active VG people whose address was cleaned or flagged (27), as a
  sheet for staff. Ten corrected addresses came back, and the next run added
  them. A recurring version of that report, "active people whose email bounces",
  may be worth offering the customer. Staff fix records themselves in the app.

## How the work was run, and what went wrong

- **The source database was wrong twice.** The workstation `.env` points at a
  development copy of VG that looks like real, current data. The July write and
  a November dry run both read it. The dry run disagreed with production on two
  of five people. On the VM the service reads production directly. Any
  workstation run should read a side database loaded from a fresh production
  dump. The tool's `--execute` refuses to write without `--source-confirmed`,
  and prints the host, port and schema.
- **The ladder of runs**: dry run (default), then staging (`--target-list` on a
  scratch audience with `--limit`), then production (`--execute
  --source-confirmed`).
- **Every write run**: a full audience snapshot first, a JSONL audit line per
  contact, a read-back of each contact's status, and a final account count. An
  exceptions CSV lists everyone in the cohort who was not mailed, and why
  (skipped, with a reason, or no address).
- Fixes to VG person data went through the API as a signed-in user, so they
  are validated and audited, never through SQL.

## Boundaries the customer has drawn

- The customer decides who is mailed, what tags mean, and what happens to
  duplicate or bad records. The engineer lays out options and consequences and
  doesn't pick.
- Staff fix one-off records themselves in VG. The service shouldn't create work
  that routes one-off fixes through the engineer.
- Opt-outs are permanent instructions: unsubscribed, archived and cleaned
  contacts are never re-added (also in the brief).

## Code worth porting (from `mailchimp-poc`)

| File | What it has |
|---|---|
| `sync-vg-to-mailchimp.mjs` | The whole run: cohort read, one pass over the audience, hash lookups for absent addresses, classify, report, write with read-back, final count. |
| `sync/vg-source.mjs` | The cohort query and email deduplication. |
| `sync/classify.mjs` | Fail-closed classification: any status other than absent or subscribed is a skip, with a reason. |
| `sync/report.mjs` | The exceptions CSV and the audit line. |
| `mailchimp.mjs` | `mc()`, `paginate()` across the API's named-array envelopes, `subscriberHash()`. |
| `backup-audience.mjs` | Full audience snapshot, plus an unsubscribed CSV. |
| `archive-unsubscribed.mjs` | The one bulk archive: it re-reads live status before each write, and refuses to run if counts differ from the reviewed figures. |

`~/dev/tvcri/vg-utils/mailchimp` holds the LGL → Mailchimp donor sync and the
only code that has written a tag (`Donor`). It is superseded as a route, since
LGL now feeds VG, but its tag write is the precedent.
