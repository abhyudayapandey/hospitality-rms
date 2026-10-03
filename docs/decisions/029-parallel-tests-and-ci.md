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
- The per-test timeout is 120 s with workers (15 s alone). Workers share the CPU with
  Postgres, and the longest tests (the loader, screen places) take 10–13 s on their own.

Locally, 3 workers on 4 cores run the DB tests in 394 s instead of 717 s.

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
