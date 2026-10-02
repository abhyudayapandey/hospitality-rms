# 019 — Rest and weekly hours are warnings; the approver can give a swap to someone else

Status: accepted · 2026-10-02

People could not offer a shift to a colleague when the swap broke minimum rest or the
weekly hours cap ("That leaves too little rest between their shifts"). Those are
judgement calls for a manager, not for the two people swapping.

- **Migration** (forward-only): `20261014100000_swap_warnings`.
- **Deploy:** no stack change, no new parameter, no re-import (`docs/deploy.md`).

## Two kinds of rule

`hr.assignment_checks` returns every rule an assignment breaks, each marked as a warning
or not:

| Rule                                             | Kind     | Why                                         |
| ------------------------------------------------ | -------- | ------------------------------------------- |
| Another place, another job role, inactive worker | blocking | They can't do the shift                     |
| Overlapping shift, approved leave                | blocking | They can't be in two places                 |
| Minimum rest (`REST_RULE`)                       | warning  | A manager may accept it, e.g. short-staffed |
| Weekly hours cap (`WEEKLY_HOURS_CAP`)            | warning  | Same                                        |

The details are worded for the screen: "would have 9 h rest between shifts (needs 10 h)",
"would have 52 h this week (limit 48 h)".

## Swaps

- **Offering and accepting** stop only on blocking rules.
- **The approver** (`hr.swap_checks`) sees every rule that applies now. Warnings show in
  amber, and the button reads **Approve anyway**.
- **Approving names the warnings.** `hr.approve_swap(swap, comment, accept)` passes the
  codes the screen showed. A blocking rule, or a warning not named (it appeared after the
  screen loaded), stops approval with its code. So nobody approves past a warning they
  didn't see.
- **The record.** The warnings approved past are stored on the swap and on the new
  assignment (`warnings_accepted`), and so in the audit log.
- **The executor's safety net** re-checks only blocking rules, since the approver has
  already weighed the warnings.

### Giving the shift to someone else

`hr.reassign_swap(swap, worker, accept)`:

- **Who.** A pending approver of the swap who also holds ROSTER modify at the shift's
  place. An area manager approving as the fallback sees rosters but can't change them,
  so they only approve or reject.
- **Not to** the person giving the shift away (that is a reject), the colleague (that is an
  approve), or the approver themselves (`SEGREGATION_OF_DUTIES`).
- **Rules.** Same rules and warnings as any assignment, named the same way.
- **What happens.**
  - The shift goes straight onto the new person's roster, with no further approval.
  - The original assignment ends as `swapped`.
  - The swap closes as `reassigned`.
  - The workflow request is rejected, with the comment "Assigned to <name> instead". The
    reject handler leaves a reassigned swap alone. The engine has no other closing state,
    and a reject is the honest record for the request: it was not approved.
- **Notifications.** Both parties hear that the shift went to someone else; the new
  person gets "New shift added".

## Managers building the roster

The same split applies. The shift screen lists warnings under each name with
**Assign anyway**, which calls `hr.assign(shift, worker, accept)`. The two-argument
`hr.assign` and `hr.approve_swap` are unchanged and still stop on every rule, so the
loader's file 25 and older callers behave as before.
