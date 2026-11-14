# Handoff: the Village Green app work for vg-sync

2026-11-11. For a session working in `~/dev/village-green`. This is step 2 of
the vg-sync build order. Nothing in it waits on the customer.

## What vg-sync is

A separate service (repo `~/dev/tvcri/vg-sync`) that keeps Little Green Light
(LGL), the customer's donor database, and Village Green in step in both
directions for donors. It reaches VG only through the API, as its own
Keycloak service account, so every change it makes is in `audit_event`.

Read first, in `~/dev/tvcri/vg-sync` on branch `lgl-vg-step1` (not pushed):

- `docs/superpowers/specs/2026-11-11-lgl-vg-sync-design.md`: the design. The
  sections that bind this work are "What is stored in VG", "The service's
  identity in VG", "Checks and the full pass" (cursors) and "Change times".
- `docs/context-2026-11-11.md`: the decisions behind it.
- `src/lgl-vg/vg.js`: the client the service already uses (client
  credentials, `GET /user`, `GET /persons?projection=detail`, privacy
  acknowledgement). New endpoints get added there in a later step.

## What the service needs from the app

1. **A role for the service.** The service account currently has the Staff
   role, which lacks `donor:write`. Add a role, by migration, holding exactly:
   `person:read`, `person:write`, `member:read`, `volunteer:read`,
   `donor:read`, `donor:write`, `sync:read`, `sync:write`. Member and volunteer
   read are needed because the API hides a person from a caller who cannot
   read any of the person's associations, and matching must see everyone.
   New permissions `sync:read` and `sync:write` (`utils/permissions.js`), and
   a scope `vg:sync`. The grant is federation-level.
2. **Four tables**, keyed on person id, so they can be joined for analysis and
   travel with backups:
   - `sync_field`: one row per person and field. Constituent id, the agreed
     value (JSON), the id of the LGL entry it corresponds to (address, email,
     phone), when it was agreed.
   - `sync_hold`: one row per thing the service is leaving alone. Constituent
     id, person id if any, field if any, reason, a fingerprint of the values
     seen, first and last seen, state (open, closed, dismissed), who dismissed
     it.
   - `sync_log`: one row per decision that did something. Run id, time,
     constituent id, person id, field, case, action, old and new value,
     outcome. This is the only record of writes to LGL: LGL does not show API
     writes in its own history.
   - `sync_run`: one row per full pass and per check that did something.
     Kind, start, end, switches, image revision, policy file hash, counts,
     result, the LGL cursor (a timestamp) and the VG cursor (an audit id).
3. **Endpoints, under scope `vg:sync`, bulk where they read or write many:**
   - **What changed.** People changed after a given `audit_event` id, with
     the fields that changed per person and the newest id returned. Return
     only rows at least a few seconds old, so a transaction that commits late
     is not skipped. Not donor-specific: the later Mailchimp executable will
     poll the same endpoint with its own cursor. Include donor-row changes as
     well as person changes.
   - Memory: read all rows, or those for a list of people; upsert a batch.
   - Holds: read open and dismissed; open, update and close a batch; dismiss
     one.
   - Runs: start, finish, read recent.
   - Log: append a batch.
4. **Not needed:** the change-time endpoint. The customer chose "Village
   Green wins" over "the newer change wins" on 2026-11-12. How held items
   reach staff is still open with the customer (the design's "Telling
   staff"); if it ends up as an email through the app, that is later work.

## Facts already established about the app

From a survey of `main` at 9d625bbb on 2026-11-11:

- The highest migration is `0032-donor.js`. A playground branch also has a
  0032; check before numbering.
- `RoleId` in the OAS has `maximum: 7`; a new role means raising it.
- `audit_event` (migration 0023) records every person, member, volunteer and
  donor change on the mutation's own transaction, with `diff` per column, and
  has no read endpoint today. `shapes.js` says the trail is SQL-only; the
  "what changed" endpoint is a deliberate, narrow exception.
- `person` has no change timestamp, so the audit trail is the only source.
- The API names a client-credentials user from `preferred_username`. Keycloak
  issues `service-account-vg-sync` for the `vg-sync` client, and the API
  creates that `user_data` row on first request. The account needs a role
  grant and a privacy acknowledgement (vg-sync's `npm run setup` records the
  acknowledgement).
- `requireStaffAccess` returns 403 to a user with no grant on everything but
  `/user`, `/op`, `/privacy` and a few others.
- The server does not resolve a town on person create or update; the service
  calls `POST /op/geocode/town` itself.

## Left to that session

- The exact OpenAPI shapes, paging, and error codes, in the app's style.
- Whether the sync tables carry foreign keys to `person` (a person with a
  donor row cannot be deleted today, so orphans are unlikely), and how long
  `sync_log` is kept.
- Tests in the app's `test/api` harness.

## Conventions that carry over

- Both repositories are public. Invented data only in code, tests, docs and
  commit messages. Three real-data leaks were caught in review on
  2026-11-11, all from text copied out of the vg-utils projects.
- Agents may run dry runs, writes to a local dev database (after a
  snapshot) and the LGL trial account. Production LGL, the production VG
  database and Mailchimp need the engineer's go-ahead for each run.
- Work on VG gets a board item: this is part of VG-202611-521 ("Sync LGL,
  Village Green and Mailchimp"), which is issue #153 in `tvcri/village-green`.
  A pull request for this work should say "Refs #153", not "Closes": the issue
  covers the whole sync, and the app work is one step of it.
