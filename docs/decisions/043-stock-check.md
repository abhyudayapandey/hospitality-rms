# 043 — The stock check: blind count, difference with a photo, no approval

Status: accepted · 2026-10-04 (migrations 20261101100000, 20261101110000, 20261101120000)

Prospect feedback (3 Oct) replaced the Count with a stock check (INV-10) done by a
verifier (INV-11), with a bar mode (INV-7) and counts that survive a cellar with no signal
(INV-8). The owner answered the open questions on 4 Oct; this records what was built.

## Decision

1. **Blind first, then the difference.** The count sheet never carries what should be
   there (`inv.stock_check_sheet` has no expected column). When the verifier asks to see
   the differences (`inv.review_stock_check`) the counts are **locked** (`CHECK_LOCKED`):
   only photos can still be added, so a count cannot be bent towards the expected figure.
   A check goes `open → review → finished`.
2. **What should be there** is the ledger's own on-hand at the start of the check
   (`inv.stock_level`), which is the closing figure `inv.variance_of` works out for the
   reports (a test compares them); there is no second formula. The check snapshots it per
   item, as the old count did.
3. **A difference posts at once, with no approval.** `inv.finish_stock_check` inserts a
   `count_adjust` per differing line (ledger only, rule 3) and tells the heads of the team
   that uses the store (`ops.team_of_store`, department heads) and the outlet's GM, never
   the person who finished it. Every difference needs a **photo** (`PHOTO_REQUIRED`), a key
   under `stockcheck/<company>/<store>/` that was uploaded for that store (`INVALID_PHOTO`).
   The old Count (`inv.start_count`, `inv.submit_count`, with approval beyond tolerance)
   **stays** for stock users' routine counts.
4. **Verified / Not verified.** `inv.stock_check_view` gives every item at a store with
   when its last finished check counted it, and who by. The Check tab shows it to everyone
   with `STOCK_CHECK` at the store. The verifier does not see the on-record quantity there.
5. **Who verifies (INV-11).** A new delivery-tree domain `STOCK_CHECK`: **modify** for the
   Cost Controller and a new **Stock Verifier** group (`STOCK_LEVELS` view + `STOCK_CHECK`
   modify; the Account Owner gives it, as any group), **view** for store keepers, hub
   managers and outlet managers (the GM). Stock users and everyone else are refused
   (`NOT_AUTHORISED`); other companies see nothing (RLS). Test Solo Bar Co. has no cost
   controller, so it gets `test.solo.stock-verifier`.
6. **Bar mode (INV-7).** A bar check counts whole bottles plus **tenths of the open one**
   (`full_units` and `tenths`); the quantity is whole bottles + tenths/10 in the item's
   stock unit (the ledger keeps `numeric(18,6)`, ADR 015). Sheets are **shelf-ordered**:
   optional columns `shelf` and `shelf_order` in onboarding file 11 (`inv.item_node`; a
   blank keeps what was set). Test Bar 3.0's bar store has shelves.
7. **One check, several devices.** A check is shared: `start_stock_check` resumes the
   unfinished check of the store, and each phone records items (with an **area** and its
   device id) one at a time. One check per store at a time (a partial unique index).
8. **Offline (INV-8).** `record_check_line` takes the time it was counted
   (`INVALID_TIME` if from the future) and keeps the count with the **latest original
   time**, so a phone that syncs late never overwrites a newer count. Counts and wastage
   queue in IndexedDB (`lib/action-queue.ts`, the punch queue's pattern) and are replayed
   by `<ActionSync>`. Wastage keeps its time on the ledger through `inv.record_wastage_at`
   (up to 24 hours old; `inv.post` reads a transaction-local `app.occurred_at`). Only small
   wastage (no photo, no approval) is queued; a photo needs the connection.
9. **S3.** Stock check photos live under `stockcheck/` (instance role put/get, lifecycle 5
   years, money data). Photos are shrunk on the phone as ever (`photo-resize.ts`).

## Consequences

- The stock check posts without approval, so a verifier can change stock; the notification
  to the heads and the GM, the photo and the audit trail are the controls. The expected
  figure is moved by sales and receipts during a long check; the check uses the snapshot,
  like the old count, and a movement that makes stock negative is refused
  (`INSUFFICIENT_STOCK`).
- Reports are untouched (the parallel report work): verified counts already reach Cost of
  sales through `count_adjust`.
- Not built: showing the tag on the Stock list rows, a separate verifier-only home card.
