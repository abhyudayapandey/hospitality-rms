# 088 — Checklists: what was done about a reading, a round for each room, and room status

Status: accepted · 2026-10-09 · migrations 20261211110000 (the new blocks), 20261211120000

Passport Hotel's temperature log asks, for each reading out of range, what was done about it,
which food was probed and whether out-of-date food was thrown away. Its housekeeping check list
is a sheet with a column per room and its status at the top (VC, OCC, ARR, HM...), and its
common-area checklist the same with an area per column. Part of `docs/plans/building-blocks.md`,
PR 2.

## Decision

1. **A reading out of its range needs what was done about it** (`ACTION_NEEDED`) before it is
   saved; the leads' notification says both. A step may also ask which food was probed (file
   29 `step_asks` = `food`, readings only) and whether out-of-date food was thrown away
   (`thrown`). Both are kept on the step.
2. **A checklist may run for each room or area** (file 29 `for_each`: `rooms`, the outlet's
   rooms of file 40, by floor and number; or named areas, `Lobby; Corridor 1`). Its round is a
   grid: each cell is a step of its own, with its row (`grid_row`) and room, so done, checked,
   signed off (ADR 087) and reported like any other. The task page shows a row per room or
   area, the first with something open unfolded.
3. **Each room has a status** (`ops.room_status`: VC vacant clean, VD vacant dirty, OCC
   occupied, ARR arriving, DEP departing, OOO out of order, HM house use; vacant clean until
   set). Housekeeping sets it on the grid, front office on the new Rooms screen. It belongs to
   the new **Rooms** block (Hotel bundle, ADR 085), domain `ROOMS`.
4. **Who keeps the rooms**: `ROOMS` modify goes to the group the minibar duty already gives
   front office and housekeeping (`MINIBAR_KEEPER`, "Checks the rooms' minibars"), and to the
   outlet's managers; area managers see it. No new duty: the same people check minibars and
   rooms.
5. **The blocks of the whole plan are registered at once** (migration 20261211110000, and
   `modules.ts`, `access.ts`): Breakage, Shelf life & labels, Excise, Training & SOPs, Logbook &
   handover, Registers, Utilities, Audits & taste panels, Rooms, Linen & uniforms, each with its
   own access domain and on by default like every block but Compliance (ADR 085). Their tables
   come with their features.

## Tests

`room-grid.db.test.ts` (rooms and areas in order; readings' action, food and thrown; room
status: who sets it, nobody else, nothing while Rooms is off; the grid shows it),
`blocks.db.test.ts` and the loader's registry test (27 blocks), `tasks.db.test.ts`, and the e2e
`room-grid.spec.ts` (the front desk marks a room arriving; the attendant checks it on the grid).
