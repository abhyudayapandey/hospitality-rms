# ADR 132: Me under headings, a whole floor in one tap, the roster's Start again

Status: accepted

- **Me under headings.** Me showed every tile in one grid (ADR 125), which grew to 24 for a GM.
  The same tiles, in the same order, now sit under headings: My work (the person's own work),
  My day (Shifts & leave, SOPs, Training, Report a problem, Things I asked for, Notifications,
  Swaps), Team (Roster), Admin (Admin, Compliance, Audits, Excise) and More (anything else they
  may open). A heading with no tiles is left out (`meGroups`, `lib/screens.ts`).
- **A whole floor.** On Give rooms each floor's heading is a button: one tap gives every room on
  that floor to the person picked; tapped again when they have it all, it takes them back.
- **Start again.** "Discard drafts" covered only tomorrow to day 7, so a draft for later today
  could not be taken back. It is now **Start again** (`hr.discard_drafts(node, monday)`): every
  draft not yet started, in the week on screen and in the template window, is discarded and
  whoever was on it freed. Published shifts and drafts already under way stay.
