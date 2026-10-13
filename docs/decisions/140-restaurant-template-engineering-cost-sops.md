# 140. A restaurant's technician, cost controller, daily checklists and starter SOPs

Date: 2026-10-13. Status: accepted. No migration. Follows the [TEST] Restaurant dry run
(ADR 139, `docs/backlog/restaurant-readiness.md`).

## Context

The dry run of a restaurant with a bar found that nobody could be given a repair (the
template had no technician), stock checks had no cost controller to verify them, the sous
chef and the assistant manager worked shifts with no checklist of their own, and no SOPs came
with the template. "Push today" looked food-only, but it already lists every dish of the
outlet, food and drinks, for every service team: the demo only had a kitchen prep running out.

## Decision

1. **Engineering** is a department of the Restaurant template (restaurant view) and the
   Bar / Pub template, on by default, with one **Technician**. It has no head: the GM (or the
   Bar Manager at a bar) runs it, so leave, repairs and alerts go to them as for any
   department without a head. A customer's files may list more technicians or a Chief
   Engineer; nothing else changes. The technician's daily checklist is the new library
   **Maintenance round** (gas, exhaust, fridges, air-con, lights, water, grease trap,
   extinguishers, pests, the fault log; Restaurant SOP FA-04 to FA-06, BOH-10, BOH-12).
2. **Admin & Finance** is on by default there too, with a **Cost Controller** and the
   Accountant. The role exists even where the GM or the Bar Manager does its work: the wizard
   still lets a role have nobody, and Who does what (ADR 061) gives its work to another role.
   The cost controller verifies stock checks (`CONTROLS_COSTS`); a count off by more than its
   tolerance is still approved by the GM.
3. **The sous chef and the assistant manager have checklists**: Line check before service
   (sous chef, 11:15 and 18:15), Mid-shift reset (15:30) and Lock-up (00:00; the assistant
   manager, else the GM). A library checklist may now name a role that works at the outlet
   itself, not in a department, and its copy goes to that role (`planOutlet`).
4. **Starter SOPs** are product code, like the checklists (`packages/domain/src/sops.ts`):
   14 short SOPs in plain words from the Restaurant and Bar manuals and the Passport Hotel
   demo, each at a department (kitchen, dining room or counter, bar, stores, engineering).
   A template lists its SOPs; `addOutlet` writes them to file 46 as `<OUTLET>-<NAME>`, so the
   wizard and Add an outlet bring them, and the customer owns its copies.

## Consequences

- Hotels, QSRs and cloud kitchens get no starter SOPs yet; their templates list none.
- [TEST] Restaurant has 19 people (a technician, a cost controller and an accountant more),
  21 checklists and 14 SOPs; its lime cordial lasts two days, so drinks show on Push today.
