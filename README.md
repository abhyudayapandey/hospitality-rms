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
