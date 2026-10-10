# 114. A demo that looks like a working hotel

Date: 2026-10-10. Status: accepted. Review: "Real use" PR 5. Migration
`20261217130000_test_past_roster`.

## Context

Passport rostered only next week, so every Home said "0 on shift" and every past clock-in read
"Unrostered". Past orders were dated at the import, kitchen prep showed −5,000 ml, bread rolls
51.9, all 27 rooms "clean", and the cola and lager photos were brands'.

## Decision

1. **File 25 weeks −1 and 0** (test customers): −1 rosters the past seven days on the days
   file 35 has the person clocking in, once per customer like the attendance it follows; 0 is
   today to Sunday on the weekdays they worked last week, inside the weekly cap. A started
   shift is assigned through `hr.record_test_assignment` (test customers only, as someone who
   builds the roster there); `hr.assign` still refuses one for everyone else.
2. **Past orders on their day**: `inv.record_test_release` dates the order and its request.
3. **Batches daily, sized to the day's sales**, so nothing runs below zero (pinned).
4. **File 40 `status`** (optional, any customer): a room's status when it has none yet; the
   app keeps it from then on. Passport loads a morning of check-outs, stay-overs and arrivals.
5. **Whole numbers** for items counted one by one (`formatQty`, unit each).
6. **No brand photo for a generic thing**: cola, beer and tonic show the drink icon until plain
   photos are added (Commons was not reachable when this was built); garam masala shows the
   spices photo.
7. **Reports and lists**: Cost of sales says "No count in this period" before its figures;
   an order still to come shows "Due …" first; Events show "2 of 2 rostered".

## Tests

`passport-demo.db.test.ts` (room states, nothing below zero, every past clock-in on a shift,
people rostered today), `qty.test.ts`.
