# 082 — The roster by person, shift types (straight, split, panzer) and "repeat this pattern"

Status: accepted · 2026-10-08 · migration 20261207100000

The Passport Hotel's GM (round 1, item 4) rosters by person: a row each with a tile per shift,
and Off; the SOPs use straight, split ("leg") and panzer shifts; a week's pattern should be
copied forward.

## Decision

1. **Shift types (file 16)**: `straight` (one block, the default), `split` (two blocks: start to
   `first_end`, `second_start` to end, in one day) and `panzer` (the late evening or overnight
   shift: it starts between 17:00 and 21:00 and ends between 01:00 and 05:00 the next morning,
   one block; the product owner's definition, about 18:00-19:00 to 03:00-04:00). A template may
   name an unpaid `break_minutes`. The loader and the database both check the shapes.
2. **A split shift is one shift with its gap as its break**, not two shifts: it is one person on
   one shift (ADR 057), each block is its own clock-in and clock-out on that shift (the timeline
   already pairs several on a shift; nothing is late or early for the break), and the rostered
   hours leave the breaks out everywhere they are summed (the weekly hours rule, the assign
   candidates, the labour and People reports, My week). Worked hours come from the clock-ins.
   A panzer's hours count to the business day it starts (ADR 057), and the rest rule applies.
   A shift from a template takes its type and break (a trigger on `hr.shift`).
3. **By person** (`/roster/week?view=people`, one department): a row per person with a tile for
   each of the department's shift types (their job role's) and Off, for the chosen day.
   `hr.set_day_shift` takes them off what they had that day there, finds or makes the day's
   shift from the template (a draft until the week is published; one more place if it is full,
   since the manager chose it) and assigns through `hr.assign`, so every roster rule runs again;
   a warning (rest, weekly hours) asks "Put them on anyway". The By shift view is unchanged.
4. **Repeat this pattern** (`hr.repeat_pattern`): the week on screen copied onto the same
   weekdays from one date to another (from tomorrow, after the week, eight weeks at most). Each
   assignment goes through the same rules; what a rule refuses or warns about is left out and
   listed, never assigned silently.

## Not now

- "Late back from the break" is not flagged; the last clock-out shows leaving early.
