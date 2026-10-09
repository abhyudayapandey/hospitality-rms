# 079 — A picture for every task and step, photos on any task kept 30 days, the pack on a count row

Status: accepted · 2026-10-08 · migration 20261204100000 · stack change (S3 lifecycle)

The Passport Hotel's GM (round 1, items 5, 6 and 21): staff who read little follow pictures;
any task may need a photo, and photos should not be kept for ever; a bar's count sheet should
tell a 750 ml bottle from a 180 ml nip.

## Decision

1. **Pictures.** 35 line pictograms in the app's style (`components/icon.tsx`: bottle on a
   shelf, thermometer, mop, broom, hand wash, fridge, oil, bin, towel, ice, knife, fire
   extinguisher, spray, …), colours from the palette. A checklist step may name one (the
   library, file 29's optional `step_icon`, or whoever edits the checklist, under "Each step's
   picture"); otherwise the app picks one from its words (`stepIcon`), else by its kind. A task
   has one by its kind, else its title (`taskIcon`). The database keeps only a chosen one
   (`ops.task_step.icon`) and accepts only the product's list (`ops.task_icon_names`, kept
   equal to `TASK_ICONS` by a test). Every library step has a picture of its own.
2. **Photos on any task.** Any step takes a photo (some need one, as before); a task takes up to
   three of its own (`ops.task_photo`, `ops.add_task_photo`), added by whoever may work it while
   it is to do and seen by whoever sees the task.
3. **Kept 30 days.** Routine task and step photos are cleared after 30 days: the nightly job
   (`ops.purge_task_photos`) clears their keys, as it does for selfies (ADR 045), and the
   bucket's rule on `tasks/routine/` removes the files at the same age (it was 90 days). A
   flagged reading's photo (copied to `tasks/keep/`) and maintenance photos stay 400 days as
   evidence. Bills, compliance documents, stock check proof, item photos and selfies are other
   prefixes and other tables: nothing here touches them, and a stack test checks it.
4. **The pack on a count row**: a chip with the pack from the item's stock unit and size
   (`inv.item_unit`, already on the sheet): "750 ml bottle", "180 ml nip" (a smaller bottle
   icon), "5 kg bag", "box of 12". Nothing for what is counted by weight or one by one.
