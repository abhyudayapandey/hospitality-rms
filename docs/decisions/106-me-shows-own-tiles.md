# 106. Me shows each person's own tiles, one picture each

Date: 2026-10-10. Status: accepted. Plan: `docs/plans/ux-audit.md` (PR 3).

## Context

Me listed every screen the person could open, in three sections. At a hotel that bought every
block, a pool attendant saw twenty tiles (Stock, Count, Wastage, Orders, Transfers, Logbook,
Registers, Breakage, Linen, Events...) and used about six. Several tiles shared one picture:
the clock was Clock and Opened packs, the list Things I asked for and Registers, the book SOPs,
Recipes and Logbook, the box Stock and Breakage.

## Decision

1. **Mine first, the rest under More** (`meTiles`, `apps/web/lib/screens.ts`). First, where
   the person has them: Clock, My shifts, Leave, SOPs, Report a problem. Then the tiles for the
   work their own duties give them. Every other screen they can open is behind one **More**
   tile that opens them in place (`components/me-more.tsx`). Nothing is lost, and nothing is
   folded when either side would have fewer than three.
2. **"Their own work" is read from the access the database returned** (`core.my_domains()`),
   never from role names: a tile is theirs when they hold its domain at more than what everyone
   who works shifts holds (`EVERYONES_ACCESS`: self-service and the groups of the
   `WORKS_SHIFTS` duty, product data). So the logbook, registers, breakage and linen every
   shift worker may write, and the events they may read, fold under More; a pool attendant's
   department store, a room attendant's minibars and rooms, a cashier's sales import, a head's
   roster and training stay first. Make, Opened packs, Breakfast, Reports and Admin are shown
   only where there is something of theirs, so they are theirs; Recipes are theirs where they
   make prep or see the recipes of a store they use.
3. **One screen per function** (ADR 048): where the person can open Stock, its tabs (Count,
   Wastage, Orders, Transfers, Bills, Stock check) fold under More; without Stock (an
   accountant's Bills) they are theirs.
4. **One picture per tile.** New line icons in the same style (24 viewBox, strokes, no fill):
   an open bottle (Opened packs), a broken glass (Breakage), a notebook with a pen (Logbook), a
   chef's hat (Recipes and Menu), a bound register (Registers), a raised hand (Things I asked
   for), a clipboard with a tick (Stock check), a megaphone (Today's briefing), a mortarboard
   (Training), a week's grid (Roster), a medal (Audits), a pie (Reports), the rupee (Sales), a
   beach umbrella (Leave), a fridge (Minibars). The bottom nav uses the same pictures.
5. The bottom nav's checks stay kept per person (`lib/shell.ts`, ADR 055); Me adds no query.

## Tests

`apps/web/lib/me-tiles.test.ts`: every catalogue role, as a hotel gives it, keeps every screen
it can open (mine plus More), someone who only works has at most nine first, and the pool
attendant, commis, server, security guard, room attendant, cashier, a department head, the
accountant and the sales manager get the set above; no two tiles share a picture. The e2e specs
that open a folded tile tap More first (`meTile`, `e2e/helpers.ts`).
