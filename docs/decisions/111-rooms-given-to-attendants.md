# 111. Rooms given to attendants

Date: 2026-10-10. Status: accepted. Review: "Real use" PR 6. Migration
`20261217100000_breakfast_day_rooms_given`. An access change (a new table and functions).

## Context

An attendant cleans their own section of about twelve rooms, but nothing recorded which rooms
were whose: Rooms and Minibars listed all 27 for everyone.

## Decision

1. **`ops.room_assignment`** (room, day, person; one person a room a day), domain `ROOMS`,
   org tree, written only through `ops.give_rooms(outlet, day, person, rooms[])`, which
   replaces that person's rooms for the day (none: unassigns). Today to a week ahead.
2. **Who gives them** (`ops.gives_rooms`): `ROOMS` modify at the outlet and `TASKS` modify at
   the outlet or one of its housekeeping departments: the executive housekeeper and the
   housekeeping supervisor. Attendants and the front desk see, never give.
3. **Never limited to their own** (the owner's ask): an attendant's Rooms shows "Your rooms"
   first, then "Other rooms" folded below, every room still tappable. With none given, all
   rooms as before. Minibars put theirs first the same way; Home shows them (ADR 113).
4. Another person's room shows their initials on the tile.

## Tests

`rooms-linen.db.test.ts` (rooms given to attendants), e2e `rooms-given.spec.ts`.
