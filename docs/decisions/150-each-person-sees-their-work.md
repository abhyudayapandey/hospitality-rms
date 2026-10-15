# 150. Each person sees their own work

Date: 2026-10-15. Status: accepted. Migration `20261231120000_push_today_food_and_drink`.

## Context

The re-audit's section 5 found tiles and cards for work the person does not do. Most came from
an outlet-level grant that sweeps in every block: the Central Kitchen Supervisor and a bar's
manager saw Rooms and Minibars, the central kitchen Events. The floor saw Orders, a bell captain
Audits, a bartender "To assign (0)" under Maintenance. The accountant had Roster in the nav with
no Roster on Me. The laundry and pool attendants counted and wasted stock they do not keep. Push
today went to a bar's security guard and a hotel's sales manager, but not to its kitchen.

## Decision

1. **A block's tile shows where its places hold something** (the checks of ADR 149): Rooms and
   Minibars where there are rooms and minibar sets, Linen & uniforms where linen is kept, Events
   at an outlet (never a central kitchen).
2. **Orders is the keepers' and managers' screen**: the floor asks from RFMs. **Audits** is for
   those who run them, or read them away from the floor (an area manager, the auditor).
   **To assign** shows only to whoever may give a repair to someone.
3. **The nav offers Roster only where Me does** (`inNavToo`). Someone who reads the roster of
   more than one place (HR, `Shell.rosterWide`) has Roster on both, as the user decided.
4. **The laundry and pool attendants no longer use the department's store** (their duty
   `USES_DEPARTMENT_STORE` is gone from the catalogue and the test and demo files).
5. **Push today is for food and drink**: everyone whose home is a kitchen or service department
   (restaurant, bar, in-room dining, banquets), and at the outlet its managers and a restaurant's
   or bar's shift leads, as the user decided.

## Consequences

- The access change (two roles lose STOCK_USER) needs the RLS all-users run before merging.
- Pickers, Homes for office roles and words for managers (the rest of section 5) follow.
