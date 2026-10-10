# 097 — What the Passport demo walk found: meters, opened packs, Breakfast, Back, Linen

Status: accepted · 2026-10-10 · migrations 20261212100000, 20261212110000, 20261212120000

Walking the Passport demo as each role, the presenter found six things wrong. Two were not
bugs: the room ready check is on the room attendant's To do from its first round (11:00 the
day after the import), and switching people as a presenter (ADR 071) caused none of them. The
rest are decided here.

## Decision

1. **Utilities lists every meter**, read yet or not (`ops.utility_meters`, UTILITIES view at
   the place): its last reading, or "No reading yet. Technician reads it at 08:00 each day"
   from the meter round of file 43. Readings are kept for good; the screen shows the last
   **60 days** per meter, newest first, 30 then "Show more" (ADR 052), then the 12 months.
2. **A commis opens packs.** The duty `OPENS_PACKS` ("Opens packs") stands for
   `PACK_OPENER@department_store`, a product group with SHELF_LIFE modify only: open a pack,
   print its label, see and close the packs open there; no stock levels, counts or other
   stores. The catalogue's Commis holds it. What may be opened is read through
   `inv.pack_items` (SHELF_LIFE at the store), not the stock tables. Someone with packs to open
   and no Stock screen gets an **Opened packs** tile.
3. **Opened is offered only where it means something**: at stores that keep an item with a
   shelf life once opened, or still have a pack open (`core.screen_places('opened')`); the
   Stock tab follows. An item with a shelf life once opened has **Open a pack** on its page.
4. **The Breakfast tile follows the database's rule** (`ops.breakfast_outlets`): front office
   and housekeeping (ROOMS), and whoever works in a kitchen or restaurant of a hotel with
   rooms. It was shown to every holder of RECIPES_TEAM, so a bar's kitchen and other places
   with no rooms saw a tile with nothing behind it. The check is kept per person with the
   other nav checks (ADR 055).
5. **Back never loops.** A detail screen reached from a list with "← Back" (an SOP, a
   training session) uses "← Back" too, so the browser's history unwinds instead of a forward
   link adding the list again.
6. **Linen at 380 px**: each item's name on its own line, the two numbers under it, labelled
   ("Sent to laundry", "Came back"); "Returned" on a uniform is a small button, not a full-width
   one.

7. **A department head's roster opens by person** (DEPARTMENT_HEAD, SUPERVISOR); everyone else
   by shift. "By shift" is `?view=shift` and holds while they move between days and weeks.
   Home's open-slot counts open it by shift, since a slot is filled there.
8. **Tiles are a person's own role's shift types.** Another role's shift is refused by the
   database (ROLE_MISMATCH, never overridable), so someone whose role has no shift type in
   the department (an executive chef) gets Off and "No shift type for Executive Chef here
   yet" instead of tiles that would each be refused. A shift they have that no tile stands for
   (added by hand) shows as its own lit tile with its times (`hr.roster_day` now returns each
   person's shift name and times), so Off is lit only when they have no shift that day.

A checklist added during the day gets its first round at its next time, never a round already
overdue (unchanged, ADR 020).
