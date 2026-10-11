# 120. Any days on a list, and every list downloads

Date: 2026-10-11. Status: accepted. Migration `20261219150000_list_days`.

## Context

Lists offered "7 days / 30 days" or a fixed window (60 days of meter readings, 2 days of
handovers), and nothing could be taken out of the app for accounts or an owner.

## Decision

1. A list's days are from one day to another, both kept, chosen with chips (Today, 7 days,
   30 days, This month) or on the calendar, never after today, a year at most
   (`lib/date-range.ts`, `DateRangePicker`).
2. Long lists keep opening as they were (paged, ADR 052) and narrow only when days are picked:
   **Pick dates** folds the picker away; **All dates** goes back (`askedRange`, `ListDays`).
   Tabs, Show more and back links keep the days.
3. The days are the place's 04:00 business days (ADR 046): `rpt.days_window(node, from, to)`
   turns them into a time range so a list filters with one clause (`lib/list-days.ts`).
4. Every list has **Download**: `/export/<list>` (`lib/exports.ts`) reads through the same
   function as its screen, as the signed-in person, so the file is the list (its tab, place
   and days); not theirs to see is 403. Orders, transfers, bills, wastage, breakage (a month),
   registers, logbook, meter readings, laundry, meals (30 days), team tasks, attendance
   exceptions, compliance, minibar history and usage. Reports keep their CSVs
   (`/reports/csv`).
5. Each list's query lives in one lib function (`order-list.ts`, `transfer-list.ts`,
   `bill-list.ts`, `wastage-list.ts`, ...) shared by the screen and its download.

## Tests

`lib/date-range.test.ts`; the lists' DB tests are their screens' (no SQL changed but the
window); e2e opens a list with dates and downloads it.
