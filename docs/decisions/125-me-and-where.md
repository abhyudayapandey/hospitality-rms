# 125. Me shows everything; a repair says where it is

Date: 2026-10-11. Status: accepted. Migration `20261220110000_maintenance_where`.

## Decision

1. **Me** shows every tile: the person's own work first, then every other screen they may
   open. Nothing is folded under "More" (ADR 106 changed).
2. **Report a problem** asks _where_ as pictures: a room (then its number), common areas,
   restaurant, bar, kitchen, banquet hall, pool, terrace, garden, parking, store, laundry,
   staff area, outside (`MAINTENANCE_WHERE`, `ops.maintenance_wheres(place)`). Only what the
   outlet has is offered: rooms where it has rooms, the pool at a hotel, a department's place
   where that department exists. `ops.maintenance_request.location` keeps it, and lists show
   it instead of the department.

## Tests

`maintenance-where.db.test.ts`, `me-tiles.test.ts`, e2e `tasks.spec.ts`.
