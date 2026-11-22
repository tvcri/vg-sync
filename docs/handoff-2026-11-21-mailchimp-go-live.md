# Handoff: VG → Mailchimp go-live

2026-11-21. For the next session in this repo. The service is
`src/vg-mailchimp/` (branch `vg-mailchimp`, not merged, not pushed; a push to
`main` builds and deploys an image). Design:
`docs/superpowers/specs/2026-11-21-vg-mailchimp-design.md`. Man page:
`docs/vg-mailchimp.1.md`. Plan:
`docs/superpowers/plans/2026-11-21-vg-mailchimp.md`.

Tasks 1 to 11 are built and reviewed; Task 12 (the workstation rehearsal) is
done except its production reads. **Nothing has been sent to Mailchimp,
production VG, production LGL, Azure, Docker Hub or the VM.** The rehearsal
used `MAILCHIMP_MOCK` throughout.

## What the rehearsal showed (counts only)

Setup: the local dev VG, the `vg-sync` service account (role 8, because role 9
exists only on an unmerged village-green branch), `MIN_COHORT=5`, and a mock
audience of invented-status contacts seeded from the cohort: 1,435 subscribed,
5 unsubscribed (3 old, 2 recent), 1 cleaned, 1 pending, 1 archived, plus 2
old unsubscribed and 1 subscribed that are not in VG.

- **Cohort read.** 1,710 cohort addresses-or-people: 1,485 candidates and 225
  with no email. With an empty mock audience a dry run held every add at the
  cap (`MAILCHIMP CAP add=1485 max=50`), as designed.
- **Dry run:** `adds=42 archives=5`, writes off, nothing changed.
- **Write run 1** (`--once --write-add --write-archive`): `adds=42
  archives=5`, exit 0. Records file: 280 lines (42 added, 5 archived, 233
  left-out: 225 no-email, 5 unsubscribed, 1 cleaned, 1 pending, 1 archived),
  i.e. one line per non-subscribed outcome and nothing for subscribed people.
  The audience snapshot was written first.
- **Write run 2:** `adds=0 archives=0`, exit 0. The mock ended at 1,478
  subscribed, 6 archived, 2 unsubscribed (recent), 1 cleaned, 1 pending.
- **Service, from the built image** (`docker build`, a scratch compose file
  with `network_mode: host`, writes off): three `STARTUP` lines, one
  `MAILCHIMP OK`, a `MAILCHIMP ALIVE` exactly five minutes after start, and
  `STOPPING`/`STOPPED` with exit 0 on `docker compose stop`. The container
  and the local image were removed afterwards.

### What differed

- **A bug in `--once`, since fixed (3be4f44).** Run by hand, `--once
  --write-add --write-archive` failed at the second write with `MAILCHIMP
  FAILED sleep is not a function`: the entry point passed no `sleep`. The
  rehearsal ran through a scratch wrapper. `main.js` now defaults `sleep` for
  every command, with a test through the real entry path.
- **Fixed in the final review:** a contact Mailchimp refuses (a 4xx other
  than 401 or 403) is now recorded (`rejected`, with the HTTP status and detail) and
  the run goes on, instead of failing every night; a 401 or 403 fails the
  run without retries (a 403 is the key or account, not the contact); a 429, 5xx or
  network error after retries, still fails the run. A landed write whose
  read-back fails is now recorded.
- **Fixed in the final review:** the audience-name check now runs in every
  run, `--once` included, before any snapshot or write (ruling R10); the
  service keeps its start-up check too.
- The mock reports an empty audience name, so the start-up line reads
  `Mailchimp audience  reached` and the name check, at start and in each
  run, is not exercised (ruling R4). A wrong name is only caught against the real audience.
- The role was not exercised: role 9 is only on the village-green branch
  `mailchimp-sync-role`.

## Go-live steps (from the spec)

0. The village-green release with the new role is in production; the engineer
   has created the Keycloak client and granted the role.
1. Deploy with both switches off. Watch a night's dry run in the logs.
2. With the engineer's go-ahead: a by-hand `--once --write-archive
   --max-archive <reviewed count>` to clear the backlog, then `--write-add`
   the same way.
3. Switch both on in `.env`, restart, and enable the alerts.

Every production Mailchimp write before step 3 is a by-hand run with the
engineer's explicit go-ahead.

## Still owed by the engineer

1. **Step 3 of Task 12: two production Mailchimp reads**, each needing a
   go-ahead. (a) The `last_changed` check: read unsubscribed contacts with
   their member activity and confirm `last_changed` tracks the unsubscribe;
   if it does not, stop (the 30-day archive age depends on it). (b) The
   real-data dry run: a production snapshot restored locally
   (`vg-utils/mysql-dump`), the service dry against the production audience,
   compared with the hand-run `sync-vg-to-mailchimp.mjs` dry run on the same
   snapshot. Counts only, names masked.
2. **village-green: merge and release role 9** (branch `mailchimp-sync-role`,
   commit `29b7b123`), then create the Keycloak client (for example
   `vg-mailchimp`), grant the role at federation level, and run `node
   src/vg-mailchimp/main.js setup --acknowledge-privacy` as that client.
3. **vg-utils: install the deployer and log-shipping changes** (branch
   `vg-mailchimp-deploy`, commit `56bbaeb`) on the VM, after checking the
   VM compose file for YAML anchors on the `email:` header (see the list
   below), and add the `mailchimp` service to the VM's compose file with its
   own `.env` and `out` directory (writable by uid 1000).
4. **Create the alerts**, disabled first: `vg-mailchimp-failed` (`MAILCHIMP
   FAILED`, `STARTUP FAILED`, `MAILCHIMP LIMIT`, `MAILCHIMP CAP`) and
   `vg-mailchimp-silent` (under one `MAILCHIMP ALIVE` in 15 minutes).
5. **The first archive by hand,** after a reviewed dry run: `--once --write-archive --max-archive <reviewed
   count>`, then `--write-add` the same way.

## Deferred minors from the build ledger

Full list: `.superpowers/sdd/2026-11-21-vg-mailchimp/progress.md` (local, not
in the repo). In short:

- Run: the archive re-read comes before the 300 ms gap; a `MIN_COHORT` failure writes an empty
  records file; a non-Error throw prints "undefined"; no test for a stop
  during the archive read-back.
- Client: the response body is read outside the retry `try`; `Retry-After` is
  uncapped; `getMember` does not encode the hash.
- Mock: it does not bump `last_changed` on update or archive; the list id's
  presence is not checked.
- Service: the start-up `getList` has no per-try timeout, so it could overrun
  the 80 s budget and the 90 s health gate; some stop and ceiling tests assert
  loosely.
- Setup and docs: an unknown option to `setup` exits 1, not 2; man page
  exit-1 cases, mock example and a long README line need a tidy.
- Deployer: its header regex rejects YAML anchors or tags on the `email:`
  line, which would fail every run; rollback with two services on one
  repository is untested.
- Role 9: its test checks keys, not values, and has no donor-only person; the
  production-dump `up()` check and `down` were not run.
- Tests missing for: a mock-optional list name, margin 0 and 4999, the image
  revision, shared invalid addresses, and the GET-only call count.
