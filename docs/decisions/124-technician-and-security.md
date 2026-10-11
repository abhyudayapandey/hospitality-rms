# 124. The technician's day, meter times, a department's compliance, security

Date: 2026-10-11. Status: accepted. Migrations `20261220120000_meter_readings_times`,
`20261220140000_compliance_by_department`.

## Context

At Passport the technician saw "Plant", a bar breakage screen and linen screens that are not
their work, no Utilities history, and no Compliance although Engineering renews the fire NOC
and refills the extinguishers. The maintenance checklists (Maintenance_Checklist.xlsx and the
weekly one) were not tasks. There was no Security department.

## Decision

1. **Daily rounds** (library `PLANT-ROUND` version 2): water treatment, tank, hot water, STP,
   generator diesel, fire alarm panel, fire safety equipment, lift, pool pump, fresh-air ducts,
   exhaust ducts, pest traps, phone lines. The meters have their own round.
2. **Meter readings** (file 43 `read_at`): blank is `auto`, twice a day (08:00 and 20:00) at a
   hotel, which runs 24 hours, else at the end of the shift (30 minutes before the latest
   shift of the round's role ends, file 16). `ops.utility_readings(place, from, to)` lists every
   reading with its time and what it used. One taken more than 30 minutes from its due time is
   shown in red with its due time. Utilities takes one day or a from–to range.
3. **READS_METERS** (group `METER_READER`, `UTILITIES` view) for the technician.
4. **Linen and breakage** are a department's own (`HANDLES_LINEN`, group `WARE_KEEPER`:
   `LINEN` and `BREAKAGE` modify at the home department). Kitchen, service and housekeeping
   roles hold it; the technician and the cashier do not.
5. **A department's compliance**: whoever works in a department sees, read only, the licences
   and regular jobs a role of that department renews, answers for or does at its outlet
   (`ops.department_sees`). Compliance is then on their Me and Home. The GM and COMPLIANCE
   holders still see all.
6. **Passport's maintenance**: Daily rounds from the xlsx, a room-by-room round, and the weekly
   checklist signed off by the chief engineer.
7. **Passport's Security** department: a supervisor and day and night guards on 12-hour shifts;
   a security checklist per shift signed off by the supervisor, the opening round, lights on
   and off, the night patrol, the handover, and the registers.

## Tests

`utilities.db.test.ts`, `compliance.db.test.ts`, `reports-access.db.test.ts`,
`test-customers-templates.test.ts`, the Passport load test.
