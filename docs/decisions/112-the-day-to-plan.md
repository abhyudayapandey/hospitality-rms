# 112. The day to plan

Date: 2026-10-10. Status: accepted. Review: "Real use" PR 2. Migration
`20261217110000_plan_day_briefing_tomorrow`.

## Context

At night the screens still planned today: "today's briefing", prep "ready by today", a roster
week ending tomorrow, leave from today, "open shifts this week" counting days gone, and a
frontline Home saying "Nothing due today".

## Decision

1. **`ops.plan_day(outlet)`**: from the evening (company setting `evening_from`, 18:00 unless
   set) until the 04:00 cut, tomorrow's business day; else today's.
2. **The briefing** is written for today or tomorrow (`ops.save_briefing`, `briefing_at`,
   `briefing_dishes` take an optional day; nothing else is allowed). In the evening Home's card
   for its writers is "Tomorrow's briefing".
3. **Prep** offers Ready on Today / Tomorrow (the day to plan first) and times; nothing is
   ticked, "Fill all N short items up to par" sets them.
4. **The roster** opens on next week from Friday evening; **leave** lists the shifts to tap;
   open shifts count the next seven days.
5. **Home**: with no shift in the next day, "Your next shift"; the owner, before today's sales
   are in, sees yesterday's whole day.

## Tests

`briefing.db.test.ts` (tomorrow's briefing), `today-view.test.ts`, `dates.test.ts`.
