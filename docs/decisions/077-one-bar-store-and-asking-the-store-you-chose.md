# 077 — One store for the bar, retiring a store, and asking the store you chose

Status: accepted · 2026-10-08 · migration 20261203100000

The Passport Hotel's GM, after ADR 076 went live, as the bar manager and the executive
housekeeper:

- the bar manager's Place showed only "Bar · Layover (rooftop)", with no way to pick the lobby
  Mini Bar;
- asking the Kitchen Store for stock listed every housekeeping item, with "here:" being
  housekeeping's own stock;
- the request read "Kitchen Store → Housekeeping Store", though housekeeping asked;
- "From" offered both bars, though "the bar is a single department, so it has a single store:
  anyone needing something from the bar asks the bar".

## Decision

1. **The Passport bar has one store, "Bar"**, for Layover on the roof and the Mini Bar in the
   lobby: one stock, one count, one par. It keeps the Layover store's code, so its stock and
   history stay. ADR 076's rule that a `department_store` duty reaches every store linked to
   the department stays (a department may still run two stores); Passport no longer uses it.
2. **A store no longer in file 02 is retired by the import** (`retireStores` in the loader):
   archived, never deleted, with its item places archived and its department links removed, so
   access re-derived in the same load stops reaching it. It must have no stock request or order
   open, and hold no stock; otherwise the import says which and what to do. At a **test
   customer** what is left on its shelves is counted out (a `count_adjust` in the ledger,
   `ref_type` `retired`) so a demo can be re-imported as it is. Every retired store is a
   warning in the dry run, and "retired stores" is a count. An empty file 02 retires nothing.
3. **Asking another store lists what that store keeps** (`inv.request_items`): from the Main
   Store, what it may give (as before, ADR 051); from any other store, the items both stores
   keep. Each line says what the asking store has and its par; never what the other store has,
   which the asker may not see. A store that keeps nothing the asker uses says so.
4. **A request names who asked first**: "Housekeeping Store asked Kitchen Store", under a small
   "Stock request" or "Request for material"; a Main Store send reads "Main Store sent to Bar".

## Why the production bar manager saw one store

The Passport re-import ran before the app with ADR 076's migration was deployed: the old
derivation gave the bar's duty at one linked store, and the same import removed file 08's
extra grants for the Mini Bar. The re-import after this decision retires the Mini Bar store,
so the question goes away.

## Consequences

- Re-import Passport after deploying: files 02, 03, 11, 12, 20, 23 and 26 changed. The dry run
  warns that the Mini Bar (lobby) store is retired with its 31 items and its stock counted out;
  7 dishes move to the Bar.
- The test customers are unchanged; the stock request list in their e2e follows the store
  chosen.
