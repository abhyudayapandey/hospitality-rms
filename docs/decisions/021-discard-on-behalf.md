# 021 — Recording who threw an expired batch away when the lead submits it

Status: accepted · 2026-10-02

ADR 020 submits a discard above the store's limit in the lead's name, because a commis
cannot raise a stock adjustment. Before this change, only the wastage lines named the
commis. The approval request, the adjustment and their audit rows named only the lead, as
if they had done it themselves.

- **Migration** (forward-only): `20261016100000_discard_on_behalf`. No stack change, no
  re-import.

## The request

`inv.post_wastage` puts the person who recorded the discard on the request's payload:

| Key                | Value                                     |
| ------------------ | ----------------------------------------- |
| `recorded_by`      | their user id                             |
| `recorded_by_name` | their name when it was sent (the history) |
| `task_id`          | the expiry task                           |

`inv.submit_adjustment` gains a `p_payload` overload for this; the old signature passes
`{}`. The Inbox reads "from <lead> for <commis>". The adjustment review says "Thrown away
by <commis>; sent for them by the system on behalf of <lead>".

## The audit log

`audit.log` gains `for_user_id`: the person a system action was done for. While
`post_wastage` writes in the lead's name, it sets `app.actor_kind = 'system'` and
`app.for_user` = the commis. Every row of the request (adjustment, lines, request, steps)
then has:

| Column        | Value      |
| ------------- | ---------- |
| `actor_id`    | the lead   |
| `actor_kind`  | `system`   |
| `for_user_id` | the commis |

That reads as "submitted for the commis by the system on behalf of the lead". The wastage
and its lines stay as the commis (`human`). The function puts all three settings back
before it returns.

`for_user_id` is null for every other row. Like `app.actor_kind`, the settings are written
only by server code inside the request's transaction, never by the browser.

## Unchanged

- The approver is the outlet manager.
- Rule 7 holds: the lead is the initiator and cannot approve it.
- The commis's own **My requests** does not list the request, because it is not theirs.
  Their task and the cost report's Expired line (`discarded_by`) name them.
