# 119. Minibar charges: a row per room on Home, and what was added to bills

Date: 2026-10-11. Status: accepted. Migration `20261219120000_minibar_history`.

## Context

The front desk's Home listed minibar charges as text. They wanted each room and its amount,
the detail on a tap, "Added to bill" on the row, and afterwards a list of what was added.

## Decision

1. Home's minibar card: a row per room (number, ₹), **More** for what was taken and who
   checked it, **Added to bill** on the row; "N more" opens the screen.
2. Minibars has a **History** tab, "Added to bills", for whoever bills them:
   `ops.minibar_charged(outlet, from, to)` (MINIBAR view, a year at most, the outlet's
   business days).
3. History and "Charged to guests" take any two days (ADR 120) and download as CSV.
