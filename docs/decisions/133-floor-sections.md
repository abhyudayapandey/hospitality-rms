# ADR 133: Floor sections

Status: accepted

A restaurant or bar divides its floor into sections and gives each server one or more per day,
as housekeeping gives rooms to attendants (ADR 111).

- The sections come from onboarding: file 47 (`department_code`, `section`, `position`). A
  section no longer listed is archived. Passport's restaurant has Section 1, 2 and 3; its bar,
  a small room, has none.
- `ops.service_section` and `ops.section_assignment` (one person per section per day), under
  the TASKS domain, read through functions. Whoever manages tasks at the department (its head, a
  captain, the GM: TASKS modify there) gives them, today up to a week ahead, only to people who
  work in that department (`ops.give_sections`). A section given again moves.
- Give sections (`/sections/give`) is laid out like the roster by person: Today or Tomorrow,
  then a row per person with every section as a tile. A tap lights it for them and saves at
  once; tapped again it comes off. A person may have several; a section someone else has shows
  their name, and a tap moves it. Home shows a server "Your section today" and the giver a Give
  sections link (`ops.my_sections`, `ops.section_places`).
- No new access group or duty: the existing task rights decide it.
