# 090 — Registers: one engine, a register per kind, kept by the roles a customer names

Status: accepted · 2026-10-09 · migration 20261211140000

Passport's security and front office keep paper registers: lost and found, incidents,
visitors, vehicles, staff going out on a gate pass, keys, fire equipment checks. They differ in
their columns, not in how they work. Part of `docs/plans/building-blocks.md`, PR 2; the
Registers block (ADR 085).

## Decision

1. **One engine** (`ops.register_entry`: a place, a register, text fields, open or closed). The
   registers and their fields are product code (`packages/domain/src/registers.ts`); the
   database checks the required fields (`ops.register_required`, kept equal by a test).
2. **Each register is on or off per customer, with the job roles that keep it** (file 45,
   `core.tenant.settings.registers`). A register not listed: lost and found and incidents are on
   at every outlet, the rest at hotels; anyone who keeps registers where they work keeps it.
   Whoever runs a department or more (ADR 060 levels) keeps every register there.
3. **Who writes where**: `REGISTERS` modify at their own department (staff, supervisors, heads)
   or the outlet (its managers), and the register's roles; area managers read.
4. **Entries are never edited or deleted.** An open entry is closed (a visitor left, a key
   came back) with who and when; lost and found says how (returned, handed to the police,
   disposed of) and, when returned, to whom. Fire equipment checks are closed when written.
   Like tasks (ADR 020), closing is an `ops.*` function that checks who may, not a workflow:
   nothing is approved.

## Tests

`registers.db.test.ts` (in and out; lost and found's outcome; required fields; who keeps which
register where; the solo bar's two; another customer; the block off), the loader test (the
required fields equal the code's), and the e2e `registers.spec.ts`.
