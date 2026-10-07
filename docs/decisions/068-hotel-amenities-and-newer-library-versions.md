# 068 — Hotel amenities, and a newer version of a library checklist

Status: accepted · 2026-10-07 · migration 20261123100000

Found while testing the set-up wizard (ADR 064) and its outlet templates (ADR 062).

## Decision

1. **A hotel's amenities are extras: "A swimming pool", "A spa", "A gym".** They are offered
   under "Anything else here?" for Hotel / Resort only. Each switches on Spa & Recreation with
   the people and checks the full-service hotel SOP gives it:

   | Extra           | People                                   | Checklists (library)                                                          |
   | --------------- | ---------------------------------------- | ----------------------------------------------------------------------------- |
   | A swimming pool | Recreation Manager, Lifeguard            | Pool safety check (SP-06), Pool water test every 2 hours (EN-08, Engineering) |
   | A spa           | Spa Manager, Therapist, Spa Receptionist | Spa opening and hygiene (SP-02)                                               |
   | A gym           | Recreation Manager                       | Gym check (SP-05)                                                             |

   The spa's people left the hotel's base roles, so ticking the gym alone brings no therapist.
   The SOP logs the steam room, sauna and jacuzzi temperatures without limits, so their steps
   have none; the spa sets its own. A repair to the pool, spa or gym is reported in
   Maintenance like any other.

2. **Breakfast is the restaurant's.** It is not a department or a tick of its own (Hotel SOP
   FB-09 runs it from the restaurant). The Departments screen says so beside Restaurant:
   "includes breakfast; untick if no meals are served" (a template department's `note`). The
   Hotel / Resort tile reads "rooms and a restaurant with breakfast; a bar, spa, pool or gym if
   it has them".
3. **"A newer version" of a library checklist.** A copy remembers its library checklist and
   version (ADR 062). When the product's library has a newer version, the checklist's screen
   says so to whoever may edit it, with "See what's new" (the new steps, what is new, what is
   gone) and "Use the new version". That replaces the steps only; the name, schedule and who it
   goes to stay the outlet's. The server takes the steps from the product library, never from
   the browser; `ops.use_library_version` checks the copy is of that checklist and the version
   newer, with the editor's access, and the change is audited. Nothing changes a copy by
   itself. Every library checklist is at version 1 today, so the note shows once one is
   revised.

## Consequences

- `ops.checklists` returns `library_code` and `library_version`.
- A new library version is a change to `packages/domain/src/checklists.ts` (the version goes
  up); outlets see the note on their next visit to that checklist.
