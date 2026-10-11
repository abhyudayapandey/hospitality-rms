# 118. The shift handover reaches the next shift; booking leads have a register

Date: 2026-10-11. Status: accepted. Migration `20261219110000_handover_card`.

## Context

The front office handover was a checklist whose note was appended to the task's description,
where nobody saw it, and the next shift had to go looking for it. Restaurant, bar and in-room
dining bills are added to guests' bills outside the app for now, and booking enquiries were
kept on paper.

## Decision

1. A checklist can be a **handover** (`ops.checklist_template.handover`, file 29 `handover`,
   the library's FRONT-OFFICE-HANDOVER version 2). Whoever works in its department (or one
   under it) sees the last one someone else finished in the last 24 hours as a card on Home:
   each step with its answer, and the note in large type, until they tap **Seen**
   (`ops.last_handovers`, `ops.see_handover`, `ops.handover_seen`).
2. A task's closing note is kept on its own (`ops.task.done_note`) and shown as a card on the
   task.
3. The front office handover's steps: arrivals, departures and VIPs noted; minibar,
   restaurant, bar and in-room dining charges added to bills (ticks: the POS and the room
   system are not connected yet; when they are, these come from them); booking leads entered;
   the cash float counted.
4. **Booking leads** is a register (ADR 090): name and phone required, dates, the rate quoted,
   a note; closed as Booked or Lost, the outcome kept.

## Tests

`handover-card.db.test.ts`: the note, the next shift sees it, the doer and another department
do not, Seen, the 24 hours, leads.
