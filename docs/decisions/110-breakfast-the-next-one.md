# 110. Breakfast opens on the next one

Date: 2026-10-10. Status: accepted. Review: "Real use" PR 1. Migration
`20261217100000_breakfast_day_rooms_given`.

## Context

At 22:40 the front desk's Breakfast screen opened on today's breakfast, already served, and
let it be changed. Totals typed on one day showed on the next (the form kept its state), a
room's guests started blank though almost every room is two, and in-room came before the
buffet most guests eat at. There was no way to look back at a past day.

## Decision

1. **The next breakfast** (`ops.breakfast_next`): today's until the outlet's breakfast ends
   (company setting `breakfast_ends`, 12:00 unless set), then tomorrow's. The screen opens on
   it; `ops.breakfast_outlets` returns it as `next_day`.
2. **A served breakfast is kept**: `ops.check_breakfast_day` refuses a day before the next
   with `BREAKFAST_SERVED`, and more than a week ahead. Earlier days open read only, from the
   chips (the last one served) or "Other day".
3. **One form per day**, keyed by the day, so nothing carries over. Buffet first, a stepper;
   room numbers only when wanted. In-room is a list of rooms; "Add a room" asks for the room
   and its guests, 2 unless changed (1 to 4). One Save.
4. **Not built**: the buffet host ticking rooms off a list from the PMS or POS. A list imported
   in the morning misses late check-ins; it needs that sync (`docs/future.md`).

## Tests

`rooms-linen.db.test.ts` (served kept, a week ahead), e2e `rooms-linen.spec.ts`.
