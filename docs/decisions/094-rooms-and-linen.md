# 094 — Rooms (contents, breakfast) and Linen & uniforms

Status: accepted · 2026-10-10 · migration 20261211180000

Passport's housekeeping knows what each room should hold, front office tells the kitchen how
many breakfasts to make and where, and the linen room tracks what is at the laundry and who has
which uniform. Part of `docs/plans/building-blocks.md`, PR 3; the Rooms and Linen & uniforms
blocks (ADR 085).

## Decision

1. **Room contents** (file 44): what a room holds and how many, by room type or for one room
   (the room's own line wins, `ops.room_expected`). They are counted, not stocked: a count is
   kept per room and item (`ops.count_room`, `ops.room_count`) and moves nothing in the stores.
   Rooms → Contents shows every room, what it should hold and its last count, short lines in
   red. Whoever holds ROOMS counts (front office and housekeeping).
2. **Breakfast by mode**: a business day's totals in-room and at the buffet
   (`ops.set_breakfast_total`), then the rooms with their guests and a note
   (`ops.set_breakfast_room`; 0 takes a room off). Front office and housekeeping hold ROOMS and
   change both, so a guest's call at night goes in. The kitchen and the restaurant (departments
   whose type is kitchen or service) read it without ROOMS (`ops.reads_breakfast`); everyone
   else is refused. Today and tomorrow, on the Breakfast screen.
3. **The laundry exchange** (`ops.record_laundry`): per place and business day, how many of each
   durable item went soiled and came back fresh; saving the day again corrects it. What is still
   at the laundry is the running difference (`ops.laundry`). Linen in a store is counted in the
   usual month-end stock check, so nothing new is needed there.
4. **Uniforms** (`ops.issue_uniform`, `ops.return_uniform`): issued to someone working at the
   outlet (what, size, how many) and returned once; the place's list shows what each person
   holds.

## Tests

`rooms-linen.db.test.ts` (a type's contents and a room's own line; a count kept, the stock
unmoved; refused items and people; breakfast entered by front office and housekeeping, read by
the kitchen and restaurant, refused to engineering; the laundry's running difference; a uniform
issued and returned once; nothing while the blocks are off), and the e2e `rooms-linen.spec.ts`.
