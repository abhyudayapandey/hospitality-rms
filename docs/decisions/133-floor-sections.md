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
- Give sections (`/sections/give`) is laid out like Give rooms: Today or Tomorrow, the person,
  then tap their sections. Home shows a server "Your section today" and the giver a Give sections
  link (`ops.my_sections`, `ops.section_places`).
- No new access group or duty: the existing task rights decide it.
