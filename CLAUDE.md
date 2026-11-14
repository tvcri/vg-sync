# vg-sync

A headless service that keeps three systems in step for Village Green (VG):

- **Little Green Light (LGL)**, the customer's donor database
- **Village Green**, the membership and volunteer app (Vue 3 + Node/Express + MySQL)
- **Mailchimp**, the customer's email audience

It runs unattended on a schedule. No staff interaction, no UI.

**Status (2026-11-14): LGL ↔ VG steps 1 to 4 are built, with a test
harness; step 5 is next.** Start with the latest `docs/handoff-*.md`. The
design is `docs/superpowers/specs/2026-11-11-lgl-vg-sync-design.md` (its
"Build order" lists the seven steps; there is one go-live, after step 7). The
harness design is `docs/superpowers/specs/2026-11-13-test-harness-design.md`.
`docs/context-2026-11-11.md` is the founding brief, now history. The VG →
Mailchimp executable comes after LGL ↔ VG.

**The engineer does not decide business rules.** Which system wins a
conflict, who gets mailed, what deceased means for a record: those are the
customer's. Do not ask the engineer to pick them. Design so they are
configuration with a safe default, and collect open ones as a short
plain-language list for the customer.

## This repo is public

Never commit real data: no names, addresses, emails, donor details, LGL or VG
record ids, sheet ids or Slack channel ids. That includes tests, fixtures,
docs, commit messages and examples. Use invented people (Jane Doe). Details
that name real people live in the agent's private memory for this project, not
in the repo.

## Where to look, and for what

Nothing here needs rediscovering from scratch. These sibling projects on the
workstation already hold the answers. Paths are local; several of these repos
have no public remote.

| Project | Look there for |
|---|---|
| `~/dev/village-green` | The app. Schema and migrations (`api/`), the Donor association on a person, `lglConstituentId`, access gates (`api/source/utils/accessGates.js`), `audit_event`. Its `CLAUDE.md` is the entry point. Any schema this service needs is an app migration there. |
| `~/dev/tvcri/vg-email-sidecar` | The model for this repo: a long-lived Node service beside the app that reads the VG database directly. Dockerfile, `.github/workflows/` (test + publish image), `.env` and key files as bind mounts. |
| `~/dev/tvcri/vg-utils/vm-sidecar-deploy` | How the email sidecar is deployed on the prod VM: cron, digest pin in the compose file, health gate, rollback, Azure alert. Hardcoded to the one `email` service today; this service needs it generalized or a sibling. |
| `~/dev/tvcri/vg-utils/vm-logship` | How container logs reach Log Analytics, which the alerts query. |
| `~/dev/tvcri/vg-utils/lgl-import` | The one-off LGL → VG donor import. `README.md`, `FINDINGS.md`, both `HANDOFF-*` files. `src/lgl.js` (API client), `src/snapshot.js` (full pull), `src/suggest.js` and `src/plan.js` (matching and the import rules), `src/person.js` (cleaning LGL values), `src/vg.js` (VG API writes). Design: `vg-utils/docs/superpowers/specs/2026-11-08-lgl-import-design.md`. |
| `~/dev/tvcri/vg-utils/lgl-cleanup` | The LGL prune. `HANDOFF-2026-09-30.md` has the LGL data model and verified API facts. `src/classify.js` is the donor/dues rule. `src/match.js` is a cautionary example (see the brief). |
| `~/dev/tvcri/vg-utils/mailchimp` | LGL donors → Mailchimp audience, additive, applies the Donor tag. `src/mailchimp.js` (client), `src/audience.js`, `src/donors.js`. |
| `~/dev/tvcri/mailchimp-poc` | VG roster → Mailchimp (`sync-vg-to-mailchimp.mjs`), audience backup, and `HANDOFF.md` plus the account reference in `docs/`: every write ever made to the account, opt-out handling, billing limits. **Start with this repo's `docs/mailchimp-findings-2026-11-11.md`**, which distills that project for the VG → Mailchimp executable without real data. |
| `~/dev/tvcri/vg-utils/vg-api` | Calling the VG API as a user (Keycloak device flow), if the API route is chosen. |
| `~/dev/tvcri/vg-utils/mysql-dump` | Prod backup and local restore, for building a test database. |
| `~/dev/tvcri/agent-onboarding/board` | The project board helper. Work on VG gets a board item. |

Code in those projects is **starting material to port**, not a dependency.
The vg-utils projects are one-offs run by hand from the workstation and stay
as they are.

## How this repo is worked

- **Who runs what.** The aim is to work through the build steps with little
  interaction, so an agent runs these itself, without asking:
  - dry runs, which read production LGL and the local dev VG database;
  - writes to the local dev VG database, once a snapshot of it has been
    taken (take one before the first write of a step);
  - anything against the LGL trial account (`.env.trial`).

  Production LGL writes, the production VG database and Mailchimp need the
  user's explicit go-ahead for each run. Say what you are about to run
  before a long run, in case the user has started it already. Mask real
  names, emails and numbers when reading output back; never paste them into
  the repo.
- **The dev VG database holds the harness's invented data** (the demo data
  generator, reseeded on every harness run). A dry run against real data
  needs a production snapshot restored there first (`vg-utils/mysql-dump`);
  a restored snapshot is real data. Partial writes to either are not
  precious; both can be reapplied. Leave the demo stack (`village-green-demo-*`,
  database port 60002) alone.
- **Every write path is dry-run by default** in the existing tooling. Keep
  that habit here.
- **Never pipe a long run through `tail`.** Stream it or `tee` it.
- **Terms.** The organization and its staff are "the customer". Keep what the
  customer asked for distinct from what the engineer proposes. VG member and
  volunteer statuses are Active and Dropped; "lapsed" applies only to donors.
