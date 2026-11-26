# Handoff: JotForm → VG go-live

2026-11-26. For whoever takes the JotForm sync live, and for the engineer.
Board card VG-202611-528. Design:
`docs/superpowers/specs/2026-11-26-jotform-vg-design.md`. Man page:
`docs/jotform-vg.1.md`. Plan: `docs/superpowers/plans/2026-11-26-jotform-vg.md`.

## Where things are

| Piece | State |
|---|---|
| VG app side (migration 0037, role 10, `/friends/sync/*`, held filter) | village-green PR #165, branch `jotform-sync`. Open, reviewed, not merged. Merging deploys. |
| The sync (`src/jotform-vg/`) | this repo, branch `jotform-vg`. Tasks 1–10 built and reviewed; not pushed. Push to `main` builds and deploys the image. |
| Holds page | not built. Waits for the customer to pick a layout. |

## What the rehearsals showed (counts only)

**Mock rehearsal, writes on, against the dev VG** (invented submissions;
the dev FC&V tables were saved first and restored after):

- `setup` signed in and found the role.
- Full pass: 3 inserted; two name holds and an unreadable hold with reason `time-spent`.
- Change pass: 7 inserted, 1 edit updated; the unreadable hold kept its reason.
- Full pass: the report deleted in the mock was deleted; the fixed report's
  unreadable hold closed. A second full pass changed nothing.
- Service mode: three STARTUP lines, a full pass, a change pass a minute
  later, `STOPPING`/`STOPPED` on TERM.
- The built image (`docker build -f jotform-vg.Dockerfile`) ran the same way.
- A full pass whose read is short refuses to delete
  (`full read returned 2 of 245 stored; nothing deleted`).

**Real JotForm form, dry run** (engineer's go-ahead; production form read
only; dev VG holding a production snapshot with the 245 July reports):

| | |
|---|---|
| Submissions read | 800 |
| Would insert / replace in place / delete | 558 / 242 / 3 |
| Would count | 638 (80%) |
| Held: name / date / unreadable | 106 / 55 / 1 |
| Open holds | 119 (63 distinct names, 55 dates, 1 unreadable) |

Matching, of 799 readable reports:

- Volunteers 96.9% matched (in the form's village 666, by email 90, in
  another village 18); 25 held, 15 distinct names.
- Members 88.6% matched (in the form's village 703, another village 5); 91
  held, 48 distinct names. Of the 91: surname in VG but first name differs
  50, surname not in VG 33, fits someone without a member record 8.
- Date holds are mostly backlog: of 64 questionable dates (counting those
  also held for a name), 50 were reported 91–180 days after the visit.
  June 2026 had 189 submissions, about twice any other month. Only 7 look
  like dates typed ahead.

**Decided 2026-11-26:** go live with the 90-day window (the engineer kept
the default). The backlog stays held until the customer accepts it on the
holds page or answers the date question.

## Go-live steps

Each production step needs the engineer's go-ahead.

1. **Merge village-green PR #165.** Its checklist is done: the header
   comment in `FcvSyncService.js` is fixed, and migration 0037 (now with
   binary collation on the name keys) was re-run `up()`, `down()`, `up()`
   on a fresh copy of the production dump.
2. **Production Keycloak client** for the sync (like the dev `vg-jot`):
   service account, top-level `vg` scope. Grant it **role 10, JotForm
   Sync, at federation level** in VG, then run
   `node src/jotform-vg/main.js setup --acknowledge-privacy` with its
   `.env`. Expect `SETUP OK`.
3. **Push `jotform-vg` to `main`** (or merge its PR). The
   `publish-jotform-vg.yml` workflow builds `carlsmig/vg-sync-jotform`.
   **The same push also rebuilds and redeploys the LGL and Mailchimp
   services.** This branch changes `package.json` and
   `.github/workflows/publish-image.yml`, and both are in the path filters of
   `publish-lgl-vg.yml` and `publish-vg-mailchimp.yml`. So the push builds
   `carlsmig/vg-sync-lgl` and `carlsmig/vg-sync-mailchimp` too, and the VM's
   deploy cron restarts the live `sync` and `mailchimp` containers on the new
   digests (same code, new image). Time the push away from their runs (not
   during an LGL pass or a Mailchimp sync) and watch their STARTUP lines and
   health gate afterwards as well as the new service's.
4. **vg-utils, on `main`, then installed on the VM:**
   - `vm-sidecar-deploy/sidecar-deploy.py`: add to `SERVICES`
     ```python
     {
         "name": "jotform",
         "repo": "carlsmig/vg-sync-jotform",
         "markers": ["STARTUP VG signed in as ", "STARTUP scheduler started "],
         "fail_re": re.compile(r"STARTUP FAILED|JOTFORM FAILED"),
         "required": False,
     },
     ```
     Leave `STARTUP JotForm form reached` out of the markers: a disabled
     form prints `JOTFORM WARN form status is …` instead, and that must not
     fail the health gate.
   - `vm-logship/ship-container-logs.py`: add `tvcri-jotform-1` to
     `CONTAINERS`.
   - `vm-sidecar-deploy/alerts-jotform.sh`, modeled on
     `alerts-mailchimp.sh`: `vg-jotform-failed` (`JOTFORM FAILED`,
     `STARTUP FAILED`) and `vg-jotform-silent` (under one `JOTFORM ALIVE`
     in 15 minutes). Consider a third on `JOTFORM WARN … failed=` lasting
     several passes: one report VG keeps refusing shows only there.
5. **On the VM:** the `jotform` service in the compose file as in
   `deploy/docker-compose.example.yml`, with `jotform/.env` (VG client of
   step 2, `JOTFORM_API_KEY`, `JOTFORM_FORM_ID`; **no `WRITE_VG`**) and
   `jotform/out` owned by uid 1000. Start it. The service uses `out/`
   only with `JOTFORM_MOCK`, to read a mock state file kept there for
   rehearsals; in production it touches no files. The mount is harmless and
   kept for mock rehearsals.
6. **Watch the dry run** for a day: `JOTFORM DRY RUN`, a `JOTFORM OK full`
   line on start that should look like the table above (more reports by
   then), `JOTFORM OK change` every 5 minutes, `JOTFORM ALIVE`. While writes
   are off, VG's cursor never moves: it stays at the newest July row. So
   every dry change pass reads everything since July and reports about
   550 or more `inserted`, the same each time. That is expected, not a
   fault; it drops to a handful once writes are on.
7. **Switch writes on:** `WRITE_VG=true` in `.env`, restart. The first full
   pass replaces the 245 July rows in place, deletes the 3, inserts the
   rest and opens the holds. Check `JOTFORM OK full … wrote=true` and the
   Hub Friends list. Enable the alerts.
8. **Board:** move card 528 along; tell the customer the reports are live
   and that about 119 items will wait for the holds page.

## If a full pass is refused

A full pass that trips the deletion guard (`full read returned <n> of <m>
stored; nothing deleted`) or the deletion cap (`full read would delete <n>
of <m> stored; nothing deleted`) writes nothing that pass. A running service
keeps its change passes, but after any restart (a deploy, a VM reboot) no
change pass runs until a full pass succeeds, so new reports stop reaching VG
too. The recovery runbook is in the man page, `docs/jotform-vg.1.md`,
SAFETY: check in JotForm whether the submissions were really deleted; if so,
stop the service, run `--once full` with `WRITE_VG=true` and
`MIN_FULL_PERCENT` lowered just enough, then restart with the normal
setting.

## Questions for the customer

From the design, with today's evidence:

1. **Implausible dates.** Default 1 day ahead / 90 days behind. 50 of 64
   questionable dates are reports filed 3–6 months late (the June
   catch-up). Accept those as they are?
2. **"Monthly Reporting Tag":** what is it for? Stored, not used.
3. **Junk names:** marking a name ignored drops the whole report. Right
   when the other name is real?
4. **A second Village question, for the volunteer:** safe to add (village
   names only) and would help matching. Raised by the customer on
   2026-11-16 and 2026-11-23; set aside with the name drop lists, not on
   its own.
5. **The holds page:** which of the two layouts.

## Owed before the holds page ships

From the design's "Deferred" and the app's independent review: endpoints
to change a remembered answer and a date decision after their hold closes
(gated by `fcv_sync:resolve`, audited); which staff role gets
`fcv_sync:read` / `fcv_sync:resolve` (today `fcv_sync:read` also opens the
sync's raw feed); the `submittedAt` time-zone label on `GET /friends`.

## Deferred minors from the build ledger

Recorded in `.superpowers/sdd/2026-11-26-jotform-vg/progress.md` (not in
the repo) and listed for the whole-branch review; none blocks go-live. The
notable ones (`CHANGE_EVERY_MINUTES` is now capped at 1440): an unknown match
role would be treated as volunteer (callers pass constants); duplicate
roster ids turn a unique match into a hold; the nickname table is a
judgment call (a short form missing from it gives no match, the safe side).

**Known, deferred: the offset-paging race.** JotForm pages by offset. Above
1000 submissions a full read takes more than one page, and a submission
deleted in JotForm between two page reads shifts the later ones up by one, so
one submission can fall off a page unread. The full pass would then delete
that report from VG, and the next night's full pass (or a change pass, if it
is edited) puts it back. The deletion cap bounds the damage; fixing it means
paging by a stable key or re-reading, which JotForm's API makes awkward.
