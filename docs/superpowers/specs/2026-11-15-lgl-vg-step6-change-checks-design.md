# LGL ↔ VG sync, step 6: the change checks

2026-11-15. Build step 6 of `2026-11-11-lgl-vg-sync-design.md` (the sync
design), on top of the step 5 service
(`2026-11-14-lgl-vg-step5-service-and-deploy-design.md`). This document
covers only what those leave open for step 6. Where they overlap, the sync
design stands, except where this document says it corrects it. Board item
VG-202611-521.

## Intent

An edit in LGL, or a new gift, should reach VG within minutes, not the next
night. An edit in VG should be noticed within a minute. Step 6 adds the two
change checks the sync design describes: the VG check every minute, and the
LGL check every five minutes (every fifteen when idle). Both run as jobs in
the step 5 scheduler.

Writes to LGL are still step 7. So in step 6 the VG check finds VG edits and
plans the copy to LGL, but that plan is recorded as `deferred`, as the full
pass already does. Step 7 then only turns a deferred decision into a write.
The engineer kept that order on 2026-11-15. Step 6 is mostly about timing
and the scheduler, where the step 5 bugs were. Step 7 carries the risk to
LGL data and gets its own review rounds.

## Goals

- The service runs a VG check every minute and an LGL check every five
  minutes, backing off to fifteen after an idle hour. Both start after the
  start-up full pass succeeds.
- The LGL check picks up constituents changed in LGL and gifts that are new
  or changed: last gift dates, new donors linked or created, linked fields
  copied to VG under the policy.
- The VG check picks up VG people changed since its cursor and decides their
  pairs as a full pass would.
- `--once vg-check` and `--once lgl-check` run one check by hand, dry unless
  `--write-vg` is given.
- `SYNC ALIVE` carries the last successful time of each check.
- A failed check does not set off the failure alert unless the failures last
  15 minutes (below; the engineer chose this on 2026-11-15).
- The full harness set still passes, with new step 6 scenarios added.

## Non-goals

- Writes to LGL, and the `--write-lgl` switch (step 7).
- How held records reach staff ("Telling staff" in the sync design).
- Any change to village-green. The change feed (`GET /sync/changes`), the
  run kinds `vg-check` and `lgl-check`, `GET /sync/runs?kind=&since=`, and
  `GET /sync/fields?personId=` already exist.
- Any change to production, the deployer, log shipping or the alerts.

## Anti-goals

- **A check that touches what it did not look at.** It must not close a hold
  on someone outside the check, and it must not unlink or mark a constituent
  missing. Only the full pass sees deletions.
- **An alert on an ordinary blip.** A VG app deploy or one LGL network error
  must not page anyone.
- **Pressing on against a refused credential or LGL's rate limit,** once a
  minute.
- **A check that blocks the nightly full pass,** or two jobs running at once.

## Approaches

**(a) The checks reuse the full pass's pure code on a subset (chosen).** Each
check works out which constituents it touched, reads only what those need,
and calls the same `planLinked`, `planUnlinked` and `applyPlan`. One set of
rules, already tested and run through the harness.

**(b) Per-field logic driven by the audit rows' field names.** The feed says
which VG fields changed, so a check could compare only those. That means a
second compare path to keep in step with the first. It is also no cheaper:
both sides are read fresh for the pair anyway, so comparing every field of
the pair costs nothing extra. Rejected. **(call)** This corrects the sync
design's line "only those are compared": a check compares every field of a
touched pair.

**(c) A check is a small full pass over cached data.** Plan everyone each
time from the cached LGL pull. That would re-decide 700-odd pairs every
minute on data up to fifteen minutes old, and the result would be the same
as (a) for anyone not touched. Rejected.

## What was verified

- **One LGL constituent read** (production read, 2026-11-15, read only):
  `GET /constituents/{id}.json` with no parameters returns the same scalar
  fields and the same `street_addresses`, `email_addresses` and
  `phone_numbers` as the expanded search. Each list is identical. It also
  returns more lists that the sync does not use. **Adding `expand=` returns
  403 Forbidden**, so the client must not send it. An unknown id returns
  404. `GET /constituents/{id}/gifts.json` works.
- **The VG change feed** (read in village-green `SyncService.getChanges`):
  it never blocks. It scans audit rows past `after` in id order and stops at
  the first missing id, unless the row after the gap is older than
  `VG_SYNC_CHANGE_GAP_SECONDS` (60). In that case it takes the gap for a
  rollback and goes past it. So a change made just after a rolled-back write
  is seen up to a minute late, and none is skipped. **(correction)** The sync
  design's "returns only audit rows at least a few seconds old" describes an
  earlier idea. It is rewritten to match the code in the same commit as the
  VG check.

## The checks

### What a check reads and decides

Common to both:

1. Find the **touched constituents**. These differ by check (below).
2. If none are touched, advance the cursor and end. Nothing is printed and
   no run row is written. This is the usual case, and it costs one or two
   requests.
3. Read every VG person (`listPersons`, one call). The check needs the links
   and, for the LGL check, people to match against. Read the memory rows for
   the people linked to touched constituents (`GET /sync/fields?personId=`,
   batched). Read the open and dismissed holds.
4. **Narrow the holds** to those whose `lglConstituentId` is a touched
   constituent. Only those go to `planLinked`, `planUnlinked` and
   `applyPlan` as existing holds. `reconcileHolds` closes every owned open
   hold it is not asked to keep, so passing all holds would close holds on
   everyone the check did not look at.
5. Plan:
   - **Linked:** `planLinked` with the touched linked constituents, their
     cached gifts, the people linked to them (a couple's partner included),
     their memory, and the narrowed refusals.
   - **Unlinked** (LGL check only): `planUnlinked` with **every** cached
     constituent and gift, every person, and **every** hold read, exactly as
     a full pass calls it. Then its output is cut down to the touched
     constituents: decisions, links, follows, creates, finishes and the
     holds it wants. The `replan` that `applyPlan` calls after a create gets
     the same treatment. **(call)** Matching compares donors with each
     other: two unlinked donors that would link to the same person are
     held (`duplicate-in-lgl`), and a new donor who looks like another is
     held. Fed only the touched donor, a check could link or create
     someone the nightly pass would hold, which is the wrong link or
     duplicate person the sync design exists to avoid. Only the holds
     passed to `reconcileHolds` as existing are narrowed (step 4).
   - **No unlinks from a check.** A linked constituent that LGL no longer
     returns (a 404 in the VG check) is left out of the check, and its pair
     is left to the full pass. `planLinked`'s `lgl-missing` and
     `no-longer-donor` results, and their unlinks, are dropped from a check's
     plan. **(call)** Deletions are the full pass's job; the sync design
     already says only it sees them.
6. **Circuit breaker.** A check counts `breakerPeople`: the people the plan
   would change, **leaving out anyone whose only change is a new last gift
   date**. Field writes, links, follows, finishes and creates count. It adds
   up `breakerPeople` from the `ok` check runs of the last 24 hours (`GET
   /sync/runs?kind=vg-check&kind=lgl-check&since=`), plus this plan. If the
   total is over `CIRCUIT_BREAKER_PEOPLE`, the check writes nothing and
   prints `PASS FAILED <kind> circuit breaker …`. Both checks then stop
   **until the next successful full pass**, which clears the trip. The full
   pass has its own breaker, so a runaway bug that also trips it stays
   stopped. A dry check that would trip says so, as a dry full pass does.
   **(engineer, 2026-11-15, option B; corrects the sync design)** The sync
   design had every change count and only a restart clear a trip. Gift dates
   are routine in a busy giving season and would trip the breaker as
   ordinary work, and today nothing restarts the service except a new
   image, so checks could stay stopped for days. Run rows of checks store
   `breakerPeople` in their counts, beside `peopleChanged`.
7. Apply with `--write-vg` / `WRITE_VG`, through the same run guard as a
   full pass (one write run at a time, across processes). A check writes a
   run row only when it applies something. A quiet check, or a dry-run
   check, writes none. **(call)**
8. Advance the cursor only after the check succeeds. A failed or stopped
   check leaves the cursor where it was, and the next check covers the same
   ground. Every decision compares current values, so going over the same
   ground again is safe.

A check has **found a change** when its plan holds anything other than
`same`: a write, a deferred decision, a hold opened, changed or closed, a
memory row recorded, a link, a create, or a new last gift date. Only a check
that found a change prints a line.

### The VG check

- **Cursor:** the highest audit id handled (`lastAuditId` from the feed).
- **Touched:** read the feed from the cursor (`limit` 1000; follow `more`).
  Of the people it reports, keep those with a donor link. Their constituents
  are the touched ones. Changes to people with no link wait for the full
  pass. The service's own writes come back here too and compare as `same`.
- **LGL reads, up to 20:** `GET /constituents/{id}.json` for each touched
  constituent (a new `lgl.getConstituent`). The fresh record replaces that
  constituent in the LGL cache, so later LGL checks and gift decisions see
  it too.
- **More than 20 touched constituents:** no LGL reads. The check decides
  those pairs from the LGL cache, which is at most one LGL check old.
  **(call, corrects the sync design)** The sync design had the check queue
  a full pass instead. That loops: a full pass's own writes come back in
  the feed, so any pass that writes more than 20 people would set off
  another, and a failing pass would be re-queued every minute, past the
  hourly retry limit. A stale cache costs little. In step 6 nothing is
  written to LGL. In step 7 every LGL write re-reads LGL first and is
  skipped as stale if the value moved, so a stale cache can delay a write
  but never overwrite an LGL edit. The check still advances its cursor.
- In step 6, every `vg-changed` field plans `to-lgl` and is recorded as
  `deferred`.

### The LGL check

- **Cursor:** the newest `updated_at` the service has seen, from LGL's
  clock. As the sync design says, it asks from two minutes before the
  cursor.
- **Reads:** `constituents/search` with `updated_from` and the three
  expands, and `gifts/search` with `updated_from` set to the day before the
  cursor's date. These are two requests, plus more pages on a busy day.
- **Touched:**
  - every constituent returned (it replaces its entry in the cache);
  - every constituent with a gift that is new to the cache or differs from
    the cached copy (the cache is updated).

  A gift the cache already holds unchanged touches nothing. That is why the
  gift cache exists: on a busy day the date-only gift filter returns today's
  and yesterday's gifts on every check. **(call)** The cache is updated only
  when the check succeeds, so a failed check's gifts still count as new on
  the retry.
- **New cursor:** the newest `updated_at` among the constituents returned,
  if it is later than the cursor.

### The LGL cache

The service keeps the latest full pass's LGL pull in memory: every
constituent (with the three expands) and every gift. The checks then keep it
up to date. `runFullPass` hands both back to the service through `onResult`,
with both cursors. A full pass replaces the cache. **(call)** The
constituents are cached as well as the gifts. The donor rule and matching
need a constituent whose gift is new even when the constituent itself did
not change, since a gift does not move the constituent's `updated_at`.

### Cursors and the full pass

- The LGL cursor comes from the full pass, as now: five minutes before the
  newest `updated_at` it pulled.
- **The VG cursor comes from the full pass too.** Before it reads VG people,
  the full pass reads the change feed through to its end, from the last
  cursor it knows, and ignores what the feed says. Then it records
  `lastAuditId` as the VG cursor. Anything changed after that point is newer
  than the people the pass reads, so the next VG check sees it. The last
  cursor known is the service's own, else the newest run row with a non-null
  `vgCursor`, else 0. Reading from 0 walks the whole audit table once, a few
  calls of 1000 rows. **(call)** This replaces the step 3 placeholder
  `vgCursor: null`.
- Both cursors are saved in every run row, as the sync design says. A dry
  full pass writes no run row, so after a dry start the next start reads
  from the older cursor again. That is harmless.

## The scheduler

### Cadence

- **The checks wait for the first successful full pass after start.** Until
  then they have no cache and no cursors. If the start-up pass fails, the
  checks wait for the hourly retry or the nightly pass, as in step 5. The
  failure alert already fires for that.
- **The VG check** runs 60 seconds after the previous VG check ended, not
  every 60 seconds on the clock. **(call)** A slow check never stacks up
  behind itself.
- **The LGL check** runs 5 minutes after the previous LGL check ended, or 15
  minutes once neither check has found a change for 60 minutes. The service
  start counts as a change, so the first hour runs at five minutes. When
  either check finds a change while the LGL check is waiting on the
  fifteen-minute interval, its next run is moved up to five minutes after
  it last ended, or to now if that time has passed. The VG check always
  stays at one minute.
- These are constants in the code, not configuration. **(call)** The sync
  design fixes them, and tests pin them.

### One job at a time

- The queue holds at most one job of each kind (`full`, `vg-check`,
  `lgl-check`), and jobs run in the order they were queued.
- A check that falls due while a full pass runs waits behind it, then runs
  against the cursors the pass set. A nightly pass that falls due while a
  check runs waits for the check, which is bounded by its ceiling.
- A check's next timer is armed when that check ends, whatever the outcome.

### Ceiling

`CHECK_TIMEOUT_MINUTES` (default 5, at most 60). It works like
`PASS_TIMEOUT_MINUTES`: when it is reached, the check is aborted with
`timeout` and fails like any other retryable failure. **(call)** Five
minutes is far more than a check needs: a quiet check is one or two
requests, and a busy one is at most 20 LGL reads.

### Stop

A stop works as it does for a full pass. Reads are raced against the stop
signal, and `applyPlan` stops between writes. The check prints
`CHECK STOPPED <kind>` and does not advance its cursor, and nothing more is
scheduled.

### LGL requests in a check

- **One attempt per LGL request, no backoff inside a check.** **(call)** The
  next check is the retry. The full pass keeps its five attempts and long
  backoff.
- **A 429 pauses the LGL reads of both checks for five minutes,** which is
  LGL's own pause. An LGL check that falls due during the pause is put off
  until it ends. A VG check that has touched constituents during the pause
  fails with `LGL rate-limited`, and its cursor stays put. A VG check with
  nothing touched still runs. This keeps a check from adding to the load
  while LGL is pausing.
- **Request budget, at worst:** 20 constituent reads a minute from the VG
  check, plus about two requests per LGL check. That is about 100 requests
  in five minutes, against LGL's 300. A full pass running at the same time
  is the only thing that could crowd it, and the scheduler never lets the
  two run together.

## Failures and log lines

The engineer chose option B on 2026-11-15:

- **`CHECK FAILED <kind> <message>`** on every failed check. It is not an
  alert pattern (the failure alert matches `PASS FAILED` and
  `STARTUP FAILED` only).
- **`PASS FAILED <kind> failing since <ISO time>: <message>`** once a kind's
  failures have lasted 15 minutes: the first failure in the run of failures
  was at least 15 minutes ago, and the latest check failed. After that it
  repeats every 60 minutes while the failures go on. **(call)** One
  `PASS FAILED` sets off the alert once. Repeating it each hour keeps the
  alert from resolving while the problem persists, without sending a page
  every check.
- **`CHECK RECOVERED <kind>`** on the first success after a `PASS FAILED`.
- **At once, as `PASS FAILED`:**
  - **A final error** (a refused credential: a Keycloak 401,
    `invalid_client` or `unauthorized_client`, or an LGL 401). Both checks
    then stop until a full pass succeeds. The nightly pass, which has the
    same final-error rule, is the next try, so a refused key is not tried
    once a minute.
  - **The circuit breaker.** Checks stop until a full pass succeeds.
- **`CHECK OK <kind> <mode> people=<n> writes=<n> deferred=<n> links=<n>
  creates=<n> holdsOpened=<n> holdsClosed=<n>`**, only from a check that
  found a change. A quiet check prints nothing, as the sync design says.
- **`SYNC ALIVE`** gains `last-vg-check=<ISO time|none>`,
  `last-lgl-check=<ISO time|none>` (the last successful check of each kind)
  and `lgl-every=<5|15>m`. The silent alert matches `SYNC ALIVE` only, so it
  is unaffected.
- A 403 inside a check is retryable, as inside a pass. If it persists, the
  15-minute rule reports it.

### Decisions files

A check that found a change appends its decisions to
`OUT_DIR/checks-<YYYY-MM-DD>.jsonl` (UTC date), one JSON line per decision
with the check kind and time added. `pruneDecisions` deletes these by the
same `DECISIONS_KEEP_DAYS`. **(call)** One file per check would be
thousands of small files a week.

## Commands

- `--once vg-check [--write-vg] [--after <auditId>] [--out <dir>]`. The
  cursor is `--after`, else the newest run row's non-null `vgCursor`. With
  neither, it refuses and says to give `--after`. It builds its LGL cache
  from the touched constituents it reads (gifts by
  `GET /constituents/{id}/gifts.json`), so it needs no full pull.
- `--once lgl-check [--write-vg] [--since <ISO time>] [--out <dir>]`. The
  cursor is `--since`, else the newest run row's non-null `lglCursor`. It
  first pulls every constituent and gift to build the cache, about 95
  seconds against production and about a second on the trial account, then
  runs one check. **(call)** With no cache it cannot tell a new gift from a
  known one, and one code path is safer than two.
- By hand, LGL requests keep the full pass's retries, since the run is
  attended. `--snapshot` and `--max-people` are not accepted. The check
  breaker uses `CIRCUIT_BREAKER_PEOPLE`.
- Both print the `CHECK OK` line (or nothing new), followed by the JSON
  counts block as `--once full` does. They exit 0 on success and 1 on
  failure. A by-hand check fails at once, with no 15-minute rule.

## Configuration added

`CHECK_TIMEOUT_MINUTES` only (`.env.example`, README). The cadences, the
20-person limit, the 15-minute alert rule and the 5-minute LGL pause are
constants.

## Testing

1. **Unit tests with injected clock and timers** (lesson 2 of the step 6
   handoff):
   - the cadence, and the idle backoff and its return to five minutes;
   - the queue with a full pass, a check falling due during a pass, and a
     nightly pass falling due during a check;
   - the check ceiling, and a stop during a check's read and during its
     apply;
   - the 15-minute rule, its hourly repeat and `CHECK RECOVERED`;
   - final errors; the circuit breaker across 24 hours of run rows, gift
     dates left out, and cleared by a successful full pass;
   - the 429 pause;
   - the cursors (an LGL cursor that only moves forward, the VG cursor taken
     from the full pass's feed read);
   - the gift cache (an unchanged gift touches nothing);
   - hold narrowing (a check never closes a hold outside its constituents);
   - a check never unlinks.
2. **Harness scenarios** using `--once lgl-check` and `--once vg-check`
   between seed and verify:
   - a name edited in LGL reaches VG;
   - a new gift on a linked donor moves the last gift date;
   - a first gift on an unlinked constituent who matches a VG person links
     them;
   - a VG edit is planned `to-lgl`, recorded `deferred`, writes nothing, and
     advances the cursor;
   - an open hold on a pair the check did not touch stays open.

   The full set must still pass. Before the long run, check the generator
   against the dev database's migration (lesson 5).
3. **The container**, as step 5's rehearsal (`.env.harness` as `.env`, with
   `WRITE_VG=true`). Check:
   - the checks start after the start-up pass;
   - an LGL edit on the trial account reaches VG within one LGL check;
   - a VG edit shows a `CHECK OK vg-check` line with `deferred=1`;
   - `SYNC ALIVE` shows both check times;
   - `docker compose stop` during a check ends cleanly.

   Snapshot the dev database before the first write.

## Left to the builder

- How the caches and cursors pass between `pass.js`, the checks and the
  service (a small state object owned by `service.js` is the obvious fit).
- Module layout: a new `src/lgl-vg/check.js` for the two checks is
  expected. The scheduler gains the job kinds.
- The exact wording of messages other than the strings fixed here.
- Keeping the sync design in step: every section this changes (the
  feed rule, "only those are compared", `vgCursor` waiting for step 6, the
  commands, the check breaker, the more-than-20 rule) is updated in the same
  commit as the code.
