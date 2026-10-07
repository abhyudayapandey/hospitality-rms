# 062 — Outlet templates and the starter library

Status: accepted · 2026-10-06

Step 3 of `docs/templates-and-cover.md` (ADR 058), on top of the duties (ADR 059), the
role catalogue (ADR 060) and cover (ADR 061).

## Context

The people who will set customers up are a sales and onboarding team, not developers. They
must never see a code, a CSV file or a command, and an outlet they set up must load first
time. Until now every outlet was written by hand into a customer's onboarding files.

## Decision

1. **Outlet formats follow the SOP manuals:** `restaurant`, `bar_pub`, `qsr`,
   `cloud_kitchen` and `hotel` (`packages/domain/src/formats.ts`).
   - `standalone_bar` becomes `bar_pub`.
   - `full_hotel` and `small_hotel` become `hotel`: a small hotel is the hotel template with
     fewer departments.
   - Franchise is not a format: it is an owner over outlets of any format.
   - One migration renames the codes. It refuses to run while a job role has hotel-size rows,
     because merging them could change someone's access (none have).
   - The loader still reads the old codes, as the new ones.
   - Access is unchanged: the same grants, before and after re-applying everyone's. Only the
     source text "job role default (standalone_bar)" reads "(bar_pub)".
2. **Templates are product code** (`packages/domain/src/templates.ts`), like the duties and the
   catalogue. A template lists:
   - its departments (on or offered), the stores they keep, and the roles it expects;
   - its starter checklists and starter items;
   - the modules it needs.
3. **How a person picks (decided 6 Oct).** One screen, in the words people use.
   - **"What is this outlet?"** One tile: Hotel / Resort, Restaurant only, Restaurant + Bar,
     Bar / Pub, Café, Quick service, Delivery-only kitchen.
   - **"Anything else here?"** Tick any: a bar, banquets and events, brews its own beer, takes
     delivery orders, cooks for our other outlets.
   - Every choice has a default, and the defaults give an outlet that loads.
4. **Café and Restaurant are one template (decided 6 Oct).**
   - A piece is marked for the café or the restaurant view. The café view lists its own
     pieces first and ticked, then "Also in a restaurant", unticked.
   - Ticking a department of the other view brings its people and checklists. A café that
     ticks the dining room gets its captain and its opening checklist.
5. **The starter checklist library** (`packages/domain/src/checklists.ts`) has 21 checklists
   taken from the SOPs, each with a code and a version.
   - An outlet gets its own copy, which records `library_code` and `library_version` on
     `ops.checklist_template` (file 29's optional `from_library`).
   - The outlet owns the copy, and a later library version reaches new outlets only (decided
     6 Oct). The version recorded now lets the outlet's GM or department head and the admins
     be offered "a newer version" later.
   - Starter checklists go to whoever is on shift, so they work before anyone is set up.
6. **A template becomes the customer's files, never a partial load.**
   - The loader treats a customer's files as the whole truth: file 06 removes access no
     longer listed. So "Add an outlet" takes the customer's complete current set
     (`platform.current_files`: the last applied import, or what the customer was created
     with) and adds the outlet's rows to it (`addOutlet`).
   - The result is stored as an upload and goes through the same dry run, report and apply
     as any import. Every check the loader has still applies.
   - Codes already in use, an extra the tile doesn't offer, or a parent that doesn't exist
     are refused in plain words.
   - Modules the outlet needs were switched on for the company, never off. Since ADR 067 a
     template switches nothing on: the plan (bundles) decides, and the review says what is
     missing.
7. **What a template writes:**
   - places: the outlet, its departments, its supply point and stores, and their links. With
     no Main Store, a department without a store uses the kitchen's;
   - roles, by catalogue code alone (ADR 060), where the customer doesn't list them already.
     A role whose duties name a department the outlet lacks is left out (an F&B Manager comes
     with a bar and banquets);
   - its starter checklists, and starter items (name and unit; the customer adds par and
     prices).

   It doesn't write people, recipes or par levels.

8. **Two console pages:**
   - **Outlet templates** (read-only, for demos);
   - **Customer → Add an outlet** (tile, ticks, a review in plain words, then the dry run).

   Step 5's wizard adds role cover, people and stock to the second page.

## Consequences

- **Nothing changes for an existing outlet** except its format's name.
- **The test customers' files use the new codes.** Their expected access is unchanged except
  for that source text.
- **Every tile loads.** With its default extras and with everything it offers, each tile is
  added to Test Company, loads with no issues, changes nobody's access, resolves every role's
  duties, and creates its checklist rounds (`outlet-template.db.test.ts`).
- **A customer imported outside the console** (the test customers, loaded by the seed) has no
  known current files until its first console import. "Add an outlet" says so.
