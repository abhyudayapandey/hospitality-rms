# Outlet Ops

A mobile-first outlet operations platform for hospitality. See `CLAUDE.md` for the stack
and rules, and `docs/LLD.md` for the design.

```sh
cp .env.example .env
pnpm i
pnpm db:up && pnpm db:migrate && pnpm db:seed
pnpm dev
pnpm lint && pnpm typecheck && pnpm test
```

## Docs

| File                         | What                                                                 |
| ---------------------------- | -------------------------------------------------------------------- |
| `docs/goal.md`               | the product goal                                                     |
| `docs/prd.md`                | requirements by module, with what is built, proposed and planned     |
| `docs/system-map.md`         | places, people, and who uses which part of the app                   |
| `docs/LLD.md`                | the original low-level design (`CLAUDE.md`'s AWS overrides win)      |
| `docs/decisions/`            | ADRs 001–021: every design decision since the LLD                    |
| `docs/ux-review.md`          | the UX review and the plan to simplify the app (proposed)            |
| `docs/reporting.md`          | the reporting design: measures, data model, who sees what (proposed) |
| `docs/deploy.md`             | the AWS runbook and every release's deploy steps                     |
| `docs/onboarding/test-data/` | the two test customers, which are also the onboarding file spec      |
