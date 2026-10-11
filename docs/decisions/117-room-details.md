# 117. A room's status says when, why and until when

Date: 2026-10-11. Status: accepted. Migration `20261219100000_room_details`.

## Context

The front desk keeps the rooms' list for the next shift. "Arriving" and "Departing" said
nothing of the time; "Out of order" nothing of why, until when or which repair; "House use"
was not used; and the status chips at the top of Rooms only explained the colours.

## Decision

1. `ops.room_status` keeps `at_time` (Arriving, Leaving), and for Out of order a `reason`
   (required), an `until` day (never in the past) and the maintenance request it waits on.
   `ops.set_room_status(room, status, details jsonb)` checks them; `raise: true` reports it to
   maintenance there and then ("Room 204: AC not cooling").
2. House use (HM) is gone: rooms in it went to Vacant clean, file 40 no longer takes it.
   Departing reads **Leaving**.
3. The tile shows the time or "till 20 Oct"; the sheet shows the reason and the repair with
   its state. The list is the room's state, so it is there for the next person on shift.
4. The chips at the top of Rooms (and Home's "Rooms now") filter the rooms (`?status=`), with
   "All rooms" to go back.

## Tests

`room-details.db.test.ts`: time, reason, until, a repair at another outlet refused, raising
one, the list read back.
