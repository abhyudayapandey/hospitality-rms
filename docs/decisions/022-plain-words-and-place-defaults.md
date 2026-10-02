# 022 — Plain words and place defaults (UX-1)

Status: accepted · 2026-10-02

The UX review (`docs/ux-review.md`) found that the app showed codes where people expect
words, and opened screens on the wrong place. UX-1 fixes the parts that need no new data.

- **Migration** (forward-only): `20261017100000_screen_place_defaults`. No stack change, no
  re-import, no change to who can see what.

## Job titles, never codes (U-3)

Job roles show by their title ("Chef de Partie", "F&B Manager"), never their code
(`CHEF_DE_PARTIE`), on the roster, My shifts, swaps, leave, events and Admin → People.

- The titles come from `hr.job_role`, which everyone signed in already reads for their own
  customer. So no new function was needed.
- `lib/job-roles.ts` turns a code into its title. A code with no title falls back to
  readable words ("Room attendant").

## The place switcher (U-4, U-5, U-7, U-8)

- **Wording.** It is labelled **Place**, not "Viewing".
- **Short names.** Options are grouped by outlet and named without it: "Kitchen Store"
  under "Test Hotel & Bar 1.0". A place named after its outlet shows as "Whole outlet" (or
  "Whole site"). Names without " – " stay as they are.
- **Which place a screen opens on** (`core.screen_places`, `preferred`):
  1. the person's home place;
  2. their outlet;
  3. the stores linked to their home, then the outlet's main store;
  4. on Roster, departments with shifts in the fortnight around today; on Exceptions,
     departments with open attendance flags;
  5. everything else, alphabetically.

  Before, home and outlet tied for first. So a commis reporting a problem started at the
  outlet, and a GM (whose home is the outlet, which Roster doesn't list) started at Admin &
  Finance with no shifts. The list of places is unchanged; only the order moves.

- **Report a problem** shows where the person works, with **Change** for anywhere else.

## Smaller wording changes

- **Home** heads with the date, not "Hello, <first word of the name>" (U-2).
  - Without menu costs, the Menu button reads **Recipes** (U-4).
  - Shortcuts already in the bottom nav aren't repeated (U-1).
  - **Clock** replaces "Clock in", which was wrong for someone already clocked in.
- **My shifts.** It shows the latest attendance flag with "Your manager reviews these. If
  one is wrong, tell them." Earlier flags fold under "N earlier" (U-15).
- **Clock.** It says "Today's shift (06:00–14:00) has ended." instead of "No shift rostered
  today." (U-16).
- **Dates.** One short style everywhere: "today, 2:54 pm", "yesterday, 9:10 am", "28 Sept,
  9:10 am" (U-25).
- **Prep list.** Every figure carries its unit, with Indian digit grouping: "par 2,000 g ·
  on hand 580 g" (U-24).
- **Apostrophes.** One straight style (').

## Checked and left as they are

- **U-17.** Tabs and Home already hide what a person can't open. The refusal pages are
  reached only by typing a URL, and the bottom nav is there as the way back.
- **U-23.** Every quantity field already opens the number pad.
