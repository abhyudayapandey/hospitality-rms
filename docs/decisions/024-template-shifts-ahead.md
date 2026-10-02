# 024 — Template shifts: the next seven days, confirm, discard

Status: accepted · 2026-10-02

**The problem.** "Add template shifts" on the Roster week built drafts for all seven days
of the week on screen, including days already past. It added them at once, with no way
back: the drafts stayed, and the only button left was Publish.

**What it does now:**

- **Range.** It adds template shifts only for **tomorrow to today + 7**, in the place's
  time zone. Today and past days are never filled from templates. The range does not
  depend on the week on screen.
- **Confirm or cancel.** The button first shows what it will add ("Add 23 draft shifts,
  Sat 3 Oct – Fri 9 Oct? Staff see them only after you publish.") with **Cancel** and
  **Add**. Cancel changes nothing.
- **Discard drafts.** While there are unpublished drafts in those days, **Discard drafts
  (n)** takes the place of Add template shifts. Discarding:
  1. asks first;
  2. cancels the drafts;
  3. frees anyone assigned to them (`drop_reason = 'shift_cancelled'`);
  4. leaves published shifts alone;
  5. notifies no one, since staff never saw a draft.
- **Publish** is unchanged: it publishes the drafts of the week on screen. When the seven
  days run into next week, a "Next week →" link sits under the buttons.

**Database** (migration `20261018100000_template_shifts_ahead`):

- **New functions.** `hr.preview_template_shifts(node)`, `hr.add_template_shifts(node)`
  and `hr.discard_drafts(node)`. Each needs ROSTER modify at the place, like
  `hr.generate_week`.
- **The template's day.** The one-shift-per-template-per-day index now leaves out
  cancelled shifts, so a discarded day can be added again. `hr.generate_week`, the dev
  seed and the loader follow the new index.
- **`hr.generate_week`** stays for the loader (file 25 shifts), but the screen no longer
  calls it.

**Tests:**

- `rostering.db.test.ts` checks:
  - adding covers tomorrow to day 7 only;
  - the preview adds nothing;
  - adding twice adds nothing more;
  - discard cancels drafts, frees people, keeps published shifts and notifies no one;
  - a discarded day can be added again;
  - staff, area managers and other outlets are refused.
- `people.spec.ts` checks the flow on the screen: cancel, add, leave and come back, keep,
  then discard.
