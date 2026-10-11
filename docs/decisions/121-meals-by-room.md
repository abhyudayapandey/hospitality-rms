# 121. Meals by room, set by the service team

Date: 2026-10-11. Status: accepted. Migration `20261219130000_meals`.

## Context

Breakfast was a typed total for the buffet with optional rooms, entered by front office and
housekeeping. The restaurant decides who eats where; lunch and dinner work the same way; the
"Other day" picker allowed future days.

## Decision

1. **Breakfast, Lunch and Dinner** (`meal` on `ops.breakfast` and `ops.breakfast_room`), each
   with its own end (company settings `breakfast_ends` 12:00, `lunch_ends` 16:00,
   `dinner_ends` 23:30): before it ends the next one is today's, after it tomorrow's
   (`ops.meal_next`); a served one is read only (BREAKFAST_SERVED); up to a week ahead.
2. **Rooms are required**: a meal's guests are its rooms' (`ops.meal_day`), set all at once
   with `ops.set_meal_rooms(outlet, day, meal, mode, rooms)` (0 takes a room off). Buffet (or
   Restaurant for lunch and dinner) first, then In-room.
3. **The service team sets them** (`ops.serves_meals`): whoever works at the outlet itself or
   in one of its service departments that serves food (a bar or lounge alone does not), with
   Rooms in the plan. The kitchen, front office and housekeeping read them
   (`ops.reads_breakfast`); the Meals tile follows both.
4. **Add rooms** opens every room as a tile, floor by floor; tap as many as come (one guest
   each), − / + inside each tile, type a number to find one. **Other day** is a look back:
   never a day after today.
5. The old `set_breakfast_total` and `set_breakfast_room` stay for scripts, through the same
   checks.

## Tests

`rooms-linen.db.test.ts` (meals by room): totals are the rooms', lunch and dinner apart with
their own ends, who sets and who reads, a room of another outlet, served and a week ahead.
