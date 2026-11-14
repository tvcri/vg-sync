# Handoff: bring the demo data generator up to date

2026-11-13. For a session working in `~/dev/village-green`. Board item
**VG-202611-522** "Bring the demo data generator up to date with migrations
28 to 33" (Scheduled, Ready). It is a draft on the board; convert it to an
issue when work starts, as the board's `README-agent.md` describes, and move
it In Progress → In Review → Done as the work goes.

## Why

vg-sync (`~/dev/tvcri/vg-sync`) keeps LGL, the customer's donor database,
and Village Green in step. Its next piece of work is a test harness: invented
scenarios seeded into the local dev VG database and into an LGL trial
account, run through the sync, and checked in both systems. The generator in
`data/` is how the dev database gets its invented population. It was last
brought up to date at migration 27, so it cannot seed a database at the
current schema.

The generator is useful beyond vg-sync (the demo and other local testing), so
the work should leave it right for those uses too, not just for the harness.

## What to do

1. **Run `npm run doctor`** in `data/` against a database at the current
   schema and fix what it reports. Its baseline is
   `data/generator/doctor-baseline.json`.
2. **Migrations 28 to 31.** Read each one's header comment; they name their
   design specs under `scratch/superpowers/specs/`. What changed, in short:
   - 0028: volunteer trainings and positions. Catalogs start empty.
   - 0029: `person.deceased` (the single source of truth for death) and a
     member drop-reason catalog, which starts empty.
   - 0030: `volunteer.status` (Pending, Active, Dropped) replaces
     `volunteer.active`, plus a volunteer drop-reason catalog.
   - 0031: `volunteer_pause`, a notification preference on an Active
     volunteer.
   Whether the generator should produce rows for the new tables (a few
   paused volunteers, some deceased people, Dropped members with reasons) is
   this session's call. A small share of each is useful to the sync harness,
   which needs deceased people.
3. **Migration 32: donors.** The `donor` table holds one row per person
   marked Donor: `personId`, `lglConstituentId` (varchar), `lastGiftDate`.
   Give a share of the invented people a donor row, **behind a sizing knob**
   in the style of the existing `VG_DEMO_*` variables, so that it can be set
   to 0. The sync harness will set it to 0 and create its own donor links,
   because its links must point at real records on the LGL trial account;
   a donor row whose `lglConstituentId` LGL does not have would read to the
   sync as a deleted donor. Generated ids should look obviously invented.
4. **Migration 33: the sync role and tables.** This is on branch
   `vg-sync-app` (PR #155, not merged yet): role 8 "Sync Service", and the
   tables `sync_field`, `sync_hold`, `sync_run`, `sync_log`. The generator
   seeds none of these; it only has to work against a schema that has them.
   Roles are catalog rows from migrations, which the generator already
   leaves alone. Whether this work branches from `main` and checks 0033 after
   #155 merges, or builds on `vg-sync-app`, is this session's call.
5. **The fields the sync compares** should come out realistic, with some
   variety: first name, last name, nickname, suffix, street, unit, city,
   state, zip, email, phone and cell, deceased and deceased date. A few
   people with a nickname, a unit, or only a cell phone make better test
   material than a uniform population.
6. Update `data/README.md` for any new knobs, and keep the dataset
   deterministic for a given seed.

## Facts about the local setup

- Two MySQL containers run locally. **The dev database,
  `village-green-orch-db-1` (host port 60001), is free to wipe and reseed.**
  **Leave the demo stack (`village-green-demo-*`, database on 60002) alone.**
- The generator's default `VG_DB_PORT` is 3308, which matches neither; set
  `VG_DB_*` for the dev database and check its credentials first.
- The dev database currently holds a restored production snapshot, which is
  real data. Reseeding it with invented data is fine; the snapshot can be
  restored again with `~/dev/tvcri/vg-utils/mysql-dump`.

## Conventions

- The repository is public. Invented data only, in code, fixtures, docs and
  commit messages. The generator's RI-lore population is fine.
- Agents may run against the local dev database freely. Nothing here
  touches production, LGL or Mailchimp.
- The related item "Demo data generator: decide its home and fix request
  dates" is a separate decision and not part of this work.

## When done

The vg-sync session needs to know: the command and environment that seed the
dev database at the current schema with donors off, and roughly how many
people that produces. Put that in the PR description.
