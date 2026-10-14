# Senior

Senior hai na. Stock, people and every role's day for hotels, bars and restaurants, on every
phone in the outlet. The app is at my.heysenior.app and the website at heysenior.app
(`apps/site`, ADR 141). See `CLAUDE.md` for the stack and rules, and `docs/LLD.md` for the
design. (The code's internal name is still outlet-ops.)

```sh
cp .env.example .env
pnpm i
pnpm db:up && pnpm db:migrate && pnpm db:seed
pnpm dev
pnpm lint && pnpm typecheck && pnpm test
```

## Docs

| File                         | What                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `docs/goal.md`               | the product goal                                                              |
| `docs/prd.md`                | requirements by module, marked built, in progress or planned                  |
| `docs/system-map.md`         | places, people, and who uses which part of the app today                      |
| `docs/LLD.md`                | the original low-level design (`CLAUDE.md`'s AWS overrides win)               |
| `docs/decisions/`            | ADRs 001–137: every design decision since the LLD                             |
| `docs/plans/`                | plans in progress (building blocks, the UX audit)                             |
| `docs/backlog/`, `future.md` | what is still to do, and what was agreed to come back to                      |
| `docs/ux-review.md`          | the first UX review (built, UX-1 to UX-6); later audits in `ux-audit-*.md`    |
| `docs/reporting.md`          | the reporting design: measures, data model, who sees what (built, R-1 to R-4) |
| `docs/sop/`                  | the SOP manuals the roles, checklists and templates follow                    |
| `docs/deploy.md`             | the AWS runbook and every release's deploy steps                              |
| `docs/onboarding/test-data/` | the two test customers, which are also the onboarding file spec               |
| `docs/onboarding/demo/`      | the Passport Hotel pilot demo files, pitch and walk-through                   |
