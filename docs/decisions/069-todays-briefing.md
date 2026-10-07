# 069 — Today's briefing note

Status: accepted · 2026-10-07 · migration 20261124100000

The pre-shift briefing of the SOPs (Restaurant day plan 11:30 and 18:30, Hotel FB-01, QSR
ST-01): a short note from the head chef or a manager for everyone on the shift. Agreed on 6 Oct
as a separate item of `docs/templates-and-cover.md` (section 7) and built with its final pass.

## Decision

1. **What it holds.**
   - Words, up to 1,000 characters: specials, guests to know about, allergies, targets.
   - "Off today": dishes picked from the outlet's menu that day (the 86 list; the word "86"
     never shows).
   - A note needs one of the two.

2. **When it shows.**
   - For the business day it is written in (the 04:00 cut in the outlet's time zone,
     `rpt.today`).
   - For the whole day, for lunch (from the cut until 16:00 outlet time) or for dinner (from
     16:00 until the next cut). Home shows the whole day's notes and those of the part it is
     now. One fixed switch-over for every company; a setting can follow if a customer asks.

3. **Where it shows.** On Home, above Push today, for everyone who works at the outlet (their
   home is the outlet or one of its departments, `ops.my_briefing`). The outlet's own note
   first, then each department's (kitchen, then service, then the rest). A writer sees "Write
   today's briefing" on the card, and "Edit" on the notes they may change, even before
   anything is written.

4. **Who writes it: a duty.**
   - **The duty** is `WRITES_SHIFT_BRIEFING`, "Writes the shift briefing", over a new group
     `BRIEFING_WRITER` at `home_department`. Its own group, because riding on
     `DEPARTMENT_HEAD` would give it to every department head (Housekeeping, Engineering)
     and it could not be covered or moved on its own.
   - **Held by default** by the heads of kitchen and service departments in the catalogue:
     Executive Chef, Head Cook, Bar Manager (in a department), F&B Manager, Restaurant
     Manager, Floor Manager, IRD Manager, Banquet Manager. Both test customers' file 06 list
     it for those roles.
   - **The outlet's managers** write at the outlet and any of its departments through
     `OUTLET_MANAGER` (BRIEFING modify in the product matrix).
   - **Cover** needs nothing new: a person covering a writer holds the grant through
     `core.derive_job_role_access` (ADR 061).

5. **One note per place, day and part.** Saving again edits it (the GM may edit the
   kitchen's). "Take down" archives it; nothing is deleted. Every write is in the audit log.
   Writes go through `ops.save_briefing` and `ops.take_down_briefing`, which check
   `core.can('BRIEFING', 'modify', place)` and raise stable codes (`NOT_ON_MENU`,
   `BRIEFING_EMPTY`, `BRIEFING_TOO_LONG`, `NOT_AUTHORISED`).

6. **Reading is a function, not the table.** `ops.briefing` has RLS on the BRIEFING domain,
   so only writers read rows directly. Everyone else reads through `ops.briefing_today(outlet)`
   (`ops.works_at`, as Push today), which gives words, dish names and the writer's name only.

7. **No module, no bundle.** It needs no switch and comes with every plan, beside tasks
   (ADR 067).

## Consequences

- An access change: a new domain and group, synced to every tenant by the product sync,
  and new rows in both test customers' access previews. A real customer's heads get the
  duty when their file 06 lists it (a re-import) or when Admin → Users gives them the Briefing
  Writer group; their GMs have it at once.
- The existing `PRE-SHIFT-BRIEFING` starter checklist stays: it is the tick that the team was
  briefed; the note is what was said.
- "Off today" is shown on the note only. It does not hide dishes from Push today or from
  sales.
