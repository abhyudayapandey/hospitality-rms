# 105. A manager's Home on one screen

Date: 2026-10-10. Status: accepted. Plan: `docs/plans/ux-audit.md` (PR 10).

## Context

The GM's Home ran to three screens: after Compliance, Do these first, Waiting for you and
Today so far came "All departments", a closed block of underlined sentences, two or three per
department. The store keeper's Receive tile said "3" and "3 to come".

## Decision

1. **Departments as tiles.** A manager's Home ends with a tile per department, two to a row,
   in the usual order (kitchen, service, housekeeping, the rest; ADR 033): its picture
   (`departmentIcon`, from its name, else its type), its name and one fact in its colour. Red:
   something runs low; amber: something waits (a repair, an attendance issue, an open shift);
   green "All done": a department they run (TASKS modify there) with nothing waiting. The fact is
   one of the department's existing lines, in that order, so its number is that line's and the
   tile opens what the line opened, at that department (ADR 048); a green tile opens the
   department's team tasks. No new figures. Across outlets only departments with something
   waiting are tiles.
2. **Nothing else moves.** Compliance stays first (its red and amber rows, one green line when
   clear), then Do these first (at most five), Waiting for you, Today so far.
3. **A number once.** The store keeper's tiles show a count as the badge; the words under a tile
   say only "nothing to come" or "nothing to send" when there is none.
