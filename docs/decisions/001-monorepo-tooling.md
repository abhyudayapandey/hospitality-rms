# 001 — Monorepo tooling choices

Status: accepted · 2026-09-29

These are the scaffold decisions that CLAUDE.md and the LLD leave open.

## Tool versions

- **TypeScript 6.0**, not 7. `typescript-eslint` (type-checked lint) supports `<6.1` only.
  Move to 7 once it's supported.
- **Vitest 4.1**, not 5. Vitest 5 drops Node 20, and our Lambdas target Node 20.
- **Node 22** for local dev and CI (`.nvmrc`). Node 20 reached end of life in April 2026.
  CLAUDE.md still says Lambdas run Node 20. **Flag:** revisit the Lambda runtime (likely
  `nodejs22.x`) when the first Lambda is deployed. `engines` stays `>=20.9` so code keeps
  working on 20.

## Tests

- Test type is decided by file name. The root `vitest.config.ts` has two projects:
  - `unit`: `*.test.ts`, no external services.
  - `db`: `*.db.test.ts` against real Postgres at `TEST_DATABASE_URL`. Files run serially.
    A global setup fails fast if the DB is unreachable.
- `pnpm test` runs both. `pnpm test:unit` and `pnpm test:db` run one each. Vitest runs from
  the root rather than per package through Turbo. That gives one config and one DB
  lifecycle, and caching DB tests would be wrong anyway.
- DB tests connect as `app_rw`, so they exercise RLS exactly as the app does.

## Database

- **Roles are cluster-level and are not in migrations.** `packages/db/docker/init/001-roles.sql`
  creates `migrator`, `app_rw` (NOBYPASSRLS) and `wf_executor`, and grants `migrator` CREATE
  on the database. docker compose runs it on first start and CI runs it with `psql`. On RDS
  the same statements run once at provisioning, with passwords from Secrets Manager.
- Migrations run as `migrator` via `MIGRATOR_DATABASE_URL` and own every object they create.
  `app_rw` is never a table owner.
- **dbmate comes from the npm package** (`dbmate`), which ships per-platform binaries. That
  pins the version in the lockfile and needs no separate install. Schema dumping is off
  (`--no-dump-schema`), so `pg_dump` isn't required.

## Lint and format

- ESLint flat config at the root: `typescript-eslint` recommended-type-checked, Next.js
  plugin rules for `apps/web`, and `eslint-config-prettier`. `pnpm lint` also runs
  `prettier --check`.
- Turbo's `agentGuidance` is off, so Turbo doesn't rewrite CLAUDE.md or create AGENTS.md.
