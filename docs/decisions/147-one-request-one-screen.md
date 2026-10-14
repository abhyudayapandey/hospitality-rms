# 147. One request, one screen; one To do list

Date: 2026-10-14. Status: accepted. Migration `20261229300000_one_request_one_screen`.

## Context

The restaurant walk found two things that made no sense to the people using the app:

1. **A request had several screens.** Sana asked the bar for soda. Calvin, the bar manager, was
   short, so he asked the Main Store. The keeper sent it, and Calvin received it, then gave it to
   Sana. Opened from RFMs → History, from a task, from an alert or from Stock, the same request
   showed a different page each time, with different buttons. "Receive it" was on the task page
   only; "It arrived: give it" was on the ask page only.
2. **Two lists of things to do.** Approvals were on "To do list" (`/inbox`); tasks were on
   "Tasks" (`/tasks`). A send task showed under Tasks but not under To do list, and the header
   tray counted only approvals.

## Decision

1. **One screen per request.** A request that began with someone's ask opens on the ask's page
   (`/stock/asks/<id>`), wherever it is opened from. A transfer page made for an ask redirects
   there (`inv.request_ask`), as do its send and receive tasks. A plain store request keeps its
   own page, and its send and receive tasks redirect to it.
2. **Every button on it.** The page shows every button the viewer may use on any step of the
   request (`lib/request-actions.ts`, `RequestActions`): approve or reject, send, give the sending
   to someone, receive, and their own send or receive task, done in place. The ask page lists
   every request in the ask's chain (`inv.ask_requests`).
3. **Whoever works on a request may open its ask.** `inv.may_follow_ask` also lets in anyone who
   follows a request made for the ask: the GM who approves it, the keeper who sends it.
4. **One To do list** (`/tasks`): first what waits for the person (orders to place, things to
   assign, approvals), then their own tasks. `/inbox` redirects to it. The nav, the header tray
   and Home all open it. Its badge counts approvals plus the person's open tasks due by today.

## Consequences

- No new access: `inv.ask_requests` and `inv.request_ask` return only what the viewer may follow.
- A receive task whose holder may not view transfers at a plain store request still opens on
  its task page.
- Nav labels: "Tasks" is now "To do list" everywhere; the frontline nav is Home, To do list, Me.
