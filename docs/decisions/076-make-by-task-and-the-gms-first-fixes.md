# 076 — Make by task, batch labels, and the GM's first round of fixes

Status: accepted · 2026-10-08 · migration 20261202100000

The Passport Hotel's GM walked the app as each role and sent 22 notes. This decision covers
the first two groups: what was broken or confusing (1, 3, 7, 11, 12, 13, 17, 18, 19) and how
making things in the kitchen and the bar should work (3, 9, 10, 15, 16).

## Decision

### Making is given, not chosen (3, 15, 16)

1. **The lead gives out what to make; everyone else makes what they were given.** The lead of
   a store's making is whoever holds task access over the team that makes things there and
   records production there (`inv.leads_making`): the executive and sous chef in the kitchen,
   the bar manager and head bartender at the bar. Only the lead records a batch straight from
   Make; anyone else gets `MAKE_BY_TASK` and records it on the task they were given
   (`ops.record_task_batch`, as before). At a store no team makes things for, whoever records
   production there leads it.
2. **Make lists what you were given** (`inv.my_make_tasks`): the open prep tasks at the store
   you may work on (yours, your job role's, your shift's), each opening its task. The lead
   also gets the picker and form, and a link to the Prep list to give out more.
3. **The task shows how to make it** (`ops.prep_task_recipe`, for whoever sees the task): the
   ingredients scaled from the recipe's batch to the task's quantity (trim loss included, as
   Make takes them), the method, and each batch made for it with a link to print its label.
4. **The Prep list** is a list of cards, each with an icon and a tick box: what is short of
   par starts ticked with its suggestion; untick what is not made today.
5. **Whoever records batches at a store sees its batches** (`inv.batches`): a commis or bar
   back recorded a batch and saw nothing, because the list needed stock view. Newest first.

### The batch label (9, 10)

6. **A batch carries what FSSAI asks of a label**: batch number, made and use-by, the veg or
   non-veg mark, the declared allergens and who made it (`inv.batch_label`, a printable page
   at `/stock/production/label/[id]`). A prep item's `food_type`, `allergens` (FSSAI's list,
   `packages/domain/src/food-label.ts`) and `batch_portions` come from file 19 (optional);
   the label says about how many portions the batch makes, scaled from the recipe's batch.

### Fixes

7. **Durable things are not stock that moves** (1): an item may be `durable` (file 10
   `item_type`, the template's linen). It stays out of "not moved in 30 days" and days on
   hand; it is still counted and valued.
8. **"Not on the menu" only where a menu is served** (18): a request from a store whose
   department is not a kitchen or service one (housekeeping) is never "unusual" for being off
   the menu, so it no longer waits for the GM, and the bar sees it at once.
9. **A department may run more than one store** (19): a `department_store` duty is given at
   every store linked to the department (`core.derive_job_role_access_at`), not one picked
   at random. The Passport bar is one department with the rooftop bar and the lobby Mini
   Bar; file 08's extra grants for the Mini Bar are gone.
   (Since ADR 077 Passport's bar has one store; the rule stays for departments with two.)
10. **A count far above what a store holds is refused** (17): more than five times the most it
    usually holds (its par, what it should have, its largest delivery in 90 days;
    `inv.count_limit`) is `COUNT_TOO_HIGH`, on the phone before it is sent and in the
    database. The count stays blind: the limit says nothing of what is there.
11. **Briefings for breakfast and late night** (11): five parts, cut at 04:00, 11:00, 16:00
    and 23:00 in the outlet's time zone (`ops.briefing_part_now`).
12. **Leave goes to the department head, then the GM** (13): a department head's own leave
    goes to the GM only (the first step falls up to the GM, who is not asked twice). The HR
    step is no longer part of it; `leave_hr_approval` in file 00 is still read but changes
    nothing.
13. **The clock-in selfie is taken with the live front camera** (12), on the screen: no file
    picker, so no photo from the gallery. A phone with no camera, or one that refuses it,
    still clocks in without a selfie, flagged for the manager (ADR 045).
14. **"First in, first out"** (7) in the bar back's restock (BAR-RESTOCK version 2).

## Consequences

- Test data: Test Company's and the Solo Bar's prep items have veg marks, allergens and
  portions; their linen is durable. Passport's bar stores are named "Bar · Layover (rooftop)"
  and "Bar · Mini Bar (lobby)" and both link to the bar department.
- Re-import Passport after deploying: file 02, 03, 08, 10, 19 and 29 changed.
- Not in this decision (later PRs, briefed in `docs/backlog/gm-feedback-round-1.md`): menu photos (2), shift tiles and patterns (4), icons and
  photos on tasks (5, 6), dish recipes with sub-recipes (8), direct issue on receiving (14),
  the minibar's refill and billing tasks (20), pack-size icons on count rows (21).
