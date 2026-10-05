# 029 — Tests in parallel, and CI in parallel jobs

Status: accepted · 2026-10-03

CI had grown to 21–24 minutes: one job ran lint, typecheck, 57 DB test files one at a time
(7.5 min) and 20 Playwright files with one browser (10.5 min), one after the other. Both
test suites ran serially because they share one seeded database and change its data.

## Decisions

**A copy of the database per DB test worker.** With `DB_TEST_WORKERS=n` (n > 1):

- The DB tests' global setup copies the seeded database n times
  (`CREATE DATABASE outlet_ops_wK TEMPLATE outlet_ops`, a few seconds each) as the local
  Postgres superuser (`PG_ADMIN_URL`, local and CI only, never a deployed database).
- Each Vitest worker points every connection string at its own copy before a test file
  loads, so pools and the processes a test starts use it too.
- The copies are dropped at the end, and the seeded database is left as it was.
- Unset or 1: one file at a time on the seeded database, as before (the RLS all-users
  workflow runs this way).
- The per-test timeout is 120 s with workers and 30 s alone (it was 15 s). It guards
  against hangs: the longest tests (the loader, screen places) take 10–13 s on their own,
  and longer beside other workers or straight after the heaviest files.

Locally, 3 workers on 4 cores run the DB tests in 394 s instead of 717 s.

**Shards by expected time** (`packages/db/test/sequencer.ts`). Vitest's own `--shard` gives
each shard the same number of files; one shard got 502 s of work and the other 98 s. The
sequencer places each file, slowest first, on the shard with the least expected time, using
the measured seconds of the slow files (any other file counts 3 s). Within a shard the
slowest files start first. Stale weights only make shards less even.

**The slow tests themselves.**

- **`rpt.report_places` was slow in the app too.** It worked out `core.visible_nodes`
  inside its row filter, once per node it tested: 0.3 s for one report and 0.8 s for
  `rpt.my_reports()` (the Reports list) for a general manager. Migration
  `20261022110000_report_places_once` works each set out once per call (about 0.2 s), with
  the same rules; the report access tests check every user against them.
- **The report refusal check** (every person, every report, every place not listed: about
  6,000 calls, 2 minutes) moved from `reports-access.db.test.ts` to its own file,
  `reports-refusals.db.test.ts`, so it runs beside the rest. ADR 052 split it in two by
  person (`reports-refusals-1` and `-2`) and re-measured the shard weights.

**CI as parallel jobs** (`.github/workflows/ci.yml`):

| Job      | Runs                                                                               |
| -------- | ---------------------------------------------------------------------------------- |
| `static` | lint, typecheck, unit tests, CDK synth; no database                                |
| `db` ×2  | half the DB test files each (`--shard`), 2 workers on their own database copies    |
| `e2e` ×3 | a third of the Playwright files each (`--shard`), each job its own seeded database |

- Shard 1 of e2e also runs the production dev-auth check, after its build.
- The Next.js build cache is kept between runs.
- A change to Markdown files only runs nothing. Test data under `docs/` is CSV, so a
  change to it still runs everything.

## Costs

- **Actions minutes.** The repository is private on GitHub Free (2,000 minutes a month).
  Six jobs bill more minutes than one (about 25 against 21 per run), while the wait goes
  from about 21 minutes to about 6.
- **Order.** A test file must pass whatever ran before it in the same database, since a
  shard or worker runs any subset of files in any order. Every shard was run on its own
  fresh database before this change; a file that relies on another's leftovers is a bug
  in that file.
