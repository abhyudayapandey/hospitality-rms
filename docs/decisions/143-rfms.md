# 143. RFMs: asking, previous asks and transfers on one screen

Date: 2026-10-14. Status: accepted. Migration `20261228120000_breakage_photo`.

## Context

After ADR 142, asking for something took three taps: Me → Things I asked for → Ask for
something. Transfers sat in the Stock tabs, apart from the asks and requests that make them.
The owner asked for one place for all of it, called RFMs (Request for Materials), and for the
head to see a late Collect task where they already look.

## Decision

1. **RFMs.** Me's "Things I asked for" tile is now "RFMs" (`/requests`). Its tabs:
   - **Ask**: the form that asks the store one's team uses (`/stock/asks/new` redirects here).
   - **Previous asks**: every request and ask, newest first (ADR 142).
   - **Transfers**: the stores' transfers (`/stock/transfers`), only for whoever may see them
     (`core.screen_places('transfers')`).
     It opens on Ask for whoever has a store to ask, else on Previous asks. Each person sees only
     what their access shows; nothing about access changes.
2. **Transfers left the Stock tabs** and have no Me tile of their own. Every link to
   `/stock/transfers` (Home's counts, a request's page) still works; the screen shows the RFMs
   tabs above its own All / To send tabs.
3. **A late Collect task.** The head already hears it (`assigned_by`) and sees it first under
   Given to others, red "Overdue". The ask's page now says by when it should reach the
   department, to whoever asked and to the head, in red once late.

4. **One story, every screen.** A send or receive task is one step of a request. Its page
   shows the request's whole story, newest first, from whoever asked first (the bartender's
   ask, the bar's request, the GM's yes, the send, the receipt), with "Open the request". The
   request's page has "Receive it" or "Send it" for whoever holds that task. Both screens say
   the same thing.
5. **Updates about one thing read as the newest.** The bell's line for several alerts about one
   request is the latest update ("On the way from the Main Store"), the earlier ones under it,
   never "2 × ...".
6. **Breakage takes a photo** of what broke, from the live camera, above the button
   (`inv.breakage.photo_key`, stored like a wastage photo under `wastage/<tenant>/<store>/`;
   `inv.record_breakage` refuses any other key). The breakage log shows it.

## Consequences

- A store keeper reaches Transfers from Me → RFMs or Home's counts, one tap more than a Stock
  tab. Home's "To send" count still opens it directly.
