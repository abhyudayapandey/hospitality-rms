# 128. Every shift type for everyone, and a custom shift

Date: 2026-10-11. Status: accepted. Migration `20261220150000_custom_shift`.

## Context

The roster by person showed only the person's own role's shift types, so a chief technician
with none always showed Off.

## Decision

1. Every shift type of the department is offered to everyone in it, their own role's first.
   A type of another role gives the person a shift of their own with its times
   (`hr.set_day_shift_any`).
2. **A custom shift**: whoever builds the roster picks a day, a start and an end
   (`hr.set_custom_shift`), at most 16 hours, overnight allowed. It replaces what the person had
   that day, and every roster rule runs on it.

## Tests

`roster-tiles.db.test.ts`, e2e `demo-fixes.spec.ts`.
