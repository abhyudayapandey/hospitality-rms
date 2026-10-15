# 153. Forms choose nothing; said once, named one way

Date: 2026-10-15. Status: accepted. Migrations `20270111040000_ask_items_by_category`,
`20270111050000_auditor_reads_access_audit`. Builds on
ADR 110 to 114 (forms choose nothing), 048 (one screen per function) and 097 ("← Back").

## Context

The re-audit's sections 6 and 7 found forms that still chose for the person (a leave type and
today's date, the first person on Give rooms, the first item in Breakage), lists in a different
order from the form beside them, things said twice on Home and the same thing named several ways.

## Decision

Forms (section 6):

1. **Leave**: no type and no days until tapped; the button says what is missing ("Pick the type of
   leave", "Pick the days off"), then "Request N days". From starts tomorrow.
2. **Give rooms**: nobody is picked; who is on shift today comes first (`ops.on_shift_today`).
3. **Breakage**: an item picker ("What broke") of things that break, durable or counted by the
   piece (`lib/breakable.ts`); frontline staff see no ₹.
4. **Ask your head** lists short items first, then by category, like Ask for supplies
   (`inv.ask_store_items` gains category and par); the "for" placeholder is "Room 104" at a hotel,
   else "Table 4" (`core.my_outlet_format()`).

The auditor:

9. **The auditor reads the access audit.** The Auditor holds AUDIT at the company's root (duty
   AUDITS_COMPANY) and could already read the audit log, but `core.access_audit` asked for
   USER_ACCESS, which manages people. AUDIT at the root now opens it, for the whole company and
   read-only (migration `20270111050000_auditor_reads_access_audit`), so the auditor's desk shows
   "Access changes this week" and Admin shows the access audit. They still cannot manage people.

Said once, one name (section 7):

5. A submitted count lists only what was counted, then "Not counted: N".
6. Home says running low once (the department tiles, not Do these first too) and tomorrow's roster
   in one tile ("Rostered X of Y", Fill).
7. A place picker with one place has no "All …" option: it would be the same list under a second
   name (`PlaceSwitcher`). An outlet in a list of its departments is "<outlet> (whole outlet)".
8. Every step's button is "Done"; the task's own photo button reads "Take a photo" like a step's;
   what comes next reads "Then: <next step>" with the rest as pictures; every back link in the app
   reads "← Back" (the team console keeps its named links). Times were already 24-hour (ADR 148).

## Consequences

- The keeper's count is now "Stock check" (tab, Home tile, heading, "Start a stock check") and
  the verifier's check is "Verify stock" ("Start verifying", "Finish verifying"; a bar's is
  "Verify bar stock"), as the product owner chose. The verb "count" stays inside the check.
- e2e specs that pressed "Save" on a step, or named a back link, now use "Done" and "← Back".
