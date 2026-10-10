# 107. Roster, clock and leave: one big button, a switch, pictures

Date: 2026-10-10. Status: accepted. Plan: `docs/plans/ux-audit.md` (PR 11).

## Decision

1. **An empty week** on the roster shows one big **Fill this week from the usual shifts**
   button: the existing template-shifts action (`hr.add_template_shifts`, ADR 024), tomorrow
   to day 7, as drafts nobody sees until they are published; Discard drafts takes them back.
   No "0 shifts · 0 draft · 0 open slots" line and no sentence. A week the templates do not
   reach says "No shifts this week" with a calendar.
2. **By person / By shift is a two-part switch** (`view-person`, `view-shift`, the chosen one
   `aria-current`), not underlined links; a department head still opens by person (ADR 097).
   The list view stays a small link.
3. **Clock**: one big camera button to clock in, the live camera only (ADR 076); "No camera?"
   stays as a small link below it (flagged, never blocked, ADR 045). With no shift today the
   card says "No shift today" with a calendar instead of an empty "Not clocked in"; today's or
   tomorrow's shift is in the card.
4. **Leave**: a picture per leave type on its balance tiles, its list, its request and the
   form (`lib/leave-icons.ts`, from the type's code or name: an umbrella for casual, a
   first-aid kit for sick, a palm for earned, a day each way for compensatory off, the rupee
   for unpaid, else a calendar). A request's status is in words, never its code.
