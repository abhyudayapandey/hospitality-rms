# 170. A section for several people

Date: 2026-10-17. Status: accepted. Migration `20270122150000`. Changes part of ADR 133.

## Context

ADR 133 let a section go to one person a day: giving it to a second person took it from the
first. A busy section often has two servers, so the owner asked for a section to go to more
than one person.

## Decision

- `ops.section_assignment` keeps one row per person per section per day (unique on section,
  day and person). Giving a section to someone adds them and takes it from nobody.
- `ops.give_sections(department, day, person, sections)` still sets exactly that person's
  sections for the day; others who have the same sections keep them. A section listed twice
  counts once.
- `ops.sections(department, day)` returns everyone who has each section: `user_ids` and
  `user_names` ("Asha, Ravi", by name), null names when nobody has it.
- Give sections: a tile names the others who have it ("also Ravi") and a tap adds this person.
  The tile is never greyed out, since a tap no longer moves it. "Given today" and Home's list
  show every name.
- No access change: the same people give sections, to the same people.
