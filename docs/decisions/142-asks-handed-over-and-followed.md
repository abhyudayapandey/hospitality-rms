# 142. An ask is handed over, followed to the end, and listed once

Date: 2026-10-14. Status: accepted. Migration `20261228110000_ask_handover`.

## Context

The restaurant test run (QA checklist BT-02, BT-03, BT-05, GM-02, SK-02, BM-04) found:

- A bartender asked their head for something and could not follow it. The alerts about it
  opened the request between stores, which they may not open: a server error page.
- The bell joined every alert of one kind on one day into one line ("3 × Stock request")
  that opened only one of them.
- Whoever asked had two lists: Things I asked for (requests) and What I asked for (asks), and
  the first was empty for them.
- Whoever asked saw "Give it to someone" on the head's ask under Given to others.
- The GM approving the Main Store's request, and the keeper sending it, never saw who it was
  for or why.
- Once the head gave it, nothing said the stock reached the department. In real life whoever
  asked walks it there.
- Stepper: + on an empty box gave 0. Histories ran oldest first.
- Alerts can't be turned on while a presenter shows the app as someone, with no word why.

## Decision

1. **Handover.** When the head gives an ask (`inv.give_staff_ask`), whoever asked gets a
   Collect task: "Collect from the <store>: <items>". It is due at the end of their shift
   today, else in 2 hours. Overdue, the head hears it like any task (`assigned_by`). Its one
   button, on the ask's page, reads "Transfer to <Dept> done" (`inv.collect_staff_ask`). No
   stock moves: the store is the department's own. The ask reads "Given by X. Take it to the
   <Dept>." until then, then "Taken to the <Dept> by Y". The head's task to receive from the
   Main Store says the same: "Transfer to <Dept> done".
2. **Follow the whole chain.** Whoever asked may follow the request made for their ask
   (`inv.may_follow`). Their alerts about it open the ask's page (`inv.tell`). Its story starts
   with the ask (`inv.request_story`).
3. **Who it is for.** The GM's approval card, the request's page and the send and receive
   tasks say "For <who asked>: <note>" (`inv.request_for_ask`). It returns nothing, never an
   error, to anyone who may not follow it, so a list never fails on one row.
4. **One list.** Things I asked for lists requests and asks together, newest first, with
   "Ask for something" under it. `/stock/asks` opens it. Me's tile shows the open asks.
5. **Asking is not handing on.** `ops.looks_after` no longer counts the ask itself as a
   handover, so whoever asked never gives the head's task to anyone.
6. **Alerts.** Only counters (new tasks, roster weeks, problems reported...) join by kind and
   day. Any other alert joins only those about the same thing (its link).
7. **No error pages.** A screen that fails says "We couldn't open this", with Go back, Try
   again and Home (`app/(app)/error.tsx`).
8. **Newest first.** Every history (a request's, a task's, a repair's) shows the latest first.
9. **Stepper.** + on an empty box gives 1 (or the least allowed); − gives the least.
10. **Showing as someone.** Profile says alerts can be turned on only by that person on their
    own phone. Home doesn't ask while showing as someone.

## Consequences

- One more task for frontline staff per ask, closed with one tap.
- The asker's alerts all open one page, so they never see the store's own steps.
