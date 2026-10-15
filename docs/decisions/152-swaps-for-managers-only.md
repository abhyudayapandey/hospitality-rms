# 152. Swaps for managers only

Date: 2026-10-15. Status: accepted. Migration `20261231150000_swaps_managers_only`. Replaces the
company setting of SW-4 (ADR 035).

## Context

Offering a shift in a swap was a company setting, on by default; Test Company turned it off so its
staff swapped with each other. The re-audit (B4) found a bar back and a bellboy offered "Swap" with
nobody of their role to take it. The user decided: "Swap / Offer a shift should not exist for
frontline roles. Only the manager level people should be able to swap/change shifts of their
employees."

## Decision

1. **Only someone who changes the roster at the shift's place offers a swap** (`hr.request_swap`,
   `SWAPS_MANAGERS_ONLY`), at every company. The setting is gone: from the defaults, Admin →
   Settings (which refuses it) and the stored settings. File 00's `swaps_managers_only` column is
   still read so old files load, and ignored.
2. Staff have no Swaps tab and no Swap button. A colleague offered a swap still accepts it, and
   the approval and its checks are unchanged. Managers change their people's shifts on the roster.
3. **Swap shows only where someone can take it**: a shift whose role nobody else holds at its
   place has no Swap button (`MyShift.colleagues`).

## Consequences

- Test Company's file 00 drops the column. The swap flows in the tests are offered by a server who
  also heads Floor Service (a fixture, so the seeded people keep their access).
- A re-import of Test Company changes nothing; the migration removes the stored setting.
