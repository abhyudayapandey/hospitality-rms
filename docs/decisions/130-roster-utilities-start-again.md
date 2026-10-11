# 130. Any shift type for anyone; Utilities is Engineering's; a test customer can start again

Date: 2026-10-11. Status: accepted. Migrations `20261221100000_roster_any_shift_type`,
`20261221110000_compliance_pages_for_department`, `20261221120000_reset_test_customer`.
Corrects ADR 124 and 128.

## Context

In the Passport demo:

- The chief engineer, tapping the technicians' **Day** for himself, got a hand-made
  "Shift 09:00–17:00" beside Day; Day never lit up, and every tap added another empty draft
  (ADR 128 copied the times into a shift with no type and left the old one behind).
- The Purchase Manager and every other department head saw **Utilities**, an empty screen:
  the department head group held it.
- A fire extinguisher's page said "We couldn't find that" to the chief engineer, though his
  Compliance list showed it (its history used the old check).
- Re-importing Passport kept tasks and shifts made from older files ("Daily plant round"):
  an import adds and changes, never removes.

## Decision

1. **The roster.** A manager puts anyone on any shift type of the department, themselves
   included. A tap puts the person on that type and lights its tile; the same tap again changes
   nothing; another tile or Off moves them. Another role's type gives them a shift of that type
   (`hr.shift.copy_of`), never a hand-made one. A shift made by a tap (`hr.shift.personal`: a
   type nobody was on yet that day, a copied type, a custom shift) is cancelled when nobody is
   left on it, so moving people leaves no empty drafts. `hr.set_day_shift_any` is gone; the
   screen calls `hr.set_day_shift`.
2. **Utilities is Engineering's.** SUPERVISOR and DEPARTMENT_HEAD no longer hold UTILITIES. It
   comes from READS_METERS (group METER_READER, view), held by the chief engineer, shift
   engineers and technicians; the GM and area managers keep it as managers of the whole
   outlet. No function needs more than view: the meters come from file 43.
3. **Compliance pages** (`ops.licence_history`, `ops.compliance_history`) open for whoever the
   list shows them to: the role named on it and its department's head (ADR 124).
4. **Start again**, test customers only (`platform.reset_test_customer`, the console's customer
   page): every row of the customer is removed in every schema, its audit trail too, keeping
   only the customer itself (name, plan, settings) and the team console's own records. Then
   its files are imported as for a new customer, and Logins links everyone's existing sign-in
   again by username (passwords stay). Refused for a real customer and unless the customer's
   name is typed. This is the one exception to "no hard deletes": a test customer's data is
   made up for demos. Photos already in the bucket stay until their lifecycle rules remove them.

## Tests

`roster-tiles.db.test.ts` (another role's type lit, a second tap adds nothing, moving and Off
leave no empty shift), e2e `demo-fixes.spec.ts`; `compliance.db.test.ts` (the chief engineer
opens the fire NOC and the lift drill, a cook does not); `utilities.db.test.ts`;
`reset-test-customer.db.test.ts` (refused for a real customer and without the name; every
table emptied, another customer untouched, every guard back on) and
`reset-reimport.db.test.ts` (an import afterwards rebuilds the customer from its files alone).
