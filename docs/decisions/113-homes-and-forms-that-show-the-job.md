# 113. Homes and forms that show the job, once

Date: 2026-10-10. Status: accepted. Review: "Real use" PRs 3 and 4. Migration
`20261217120000_homes_forms`.

## Context

Home did not show the person's job (no rooms for an attendant, no minibar bills for the front
desk, no events for the banquet manager), showed some things three times (an overdue pest
control in the Compliance card, the task list and "1 task is late"), and forms guessed
(Black pepper and "Spoiled" chosen before anyone tapped).

## Decision

1. **Home cards for the job** (`lib/home-work.ts`, `home-cards.tsx`), each read through a
   function that checks access: Your rooms (ADR 111, tap to set the status) or the room board;
   minibar charges to post with "Added to the bill" (the front desk) or minibars to check, theirs
   first; the next breakfast (those who keep it, and department heads); events in the next 7
   days with people rostered against needed (`ops.event_staffing`); in the evening, tomorrow's
   roster where they build it.
2. **Once**: a compliance reminder is a row of the Compliance card, never a task as well; the
   cashier's import is its card, not a tile too; "My tasks" is not a tile (it is a tab).
3. **Tiles**: own work first (Make, Recipes, Rooms, Minibars, Linen, Breakfast, Stock), then
   "Shifts & leave" (one tile: Clock and Leave are its tabs) and Report a problem. Me the same
   way; reading the sales is under More.
4. **A shift lead** (a supervisor with nothing above frontline: a bell captain, a captain) gets
   the frontline Home and nav. **A GM** sees only the departments in the red, names in full.
5. **Breakfast** is read by the kitchen and the restaurant, not the bar (`ops.reads_breakfast`).
6. **Forms**: wastage and opened packs pick by picture (`ItemPicker`), nothing chosen; reasons
   are chips; a photo sits above the button. Report a problem is a photo, then what and where
   as taps, rooms by number. Linen sends and receives in two tabs ("2 short"). Minibars open
   on To charge for the front desk. The count rule sits behind a "?".
7. **On shift**: person pickers put who is on shift today first (`ops.on_shift_today`) and say
   when someone isn't. A refusal in the database was tried and dropped: tasks are rightly
   given ahead to people rostered later, and compliance jobs to whoever answers for them.

## Tests

`homes.db.test.ts`, `screens.test.ts`, `me-tiles.test.ts`, e2e `journeys.spec.ts`,
`rooms-linen.spec.ts`, `stock-policies.spec.ts`, `shelf-life-breakage.spec.ts`.
