# 167. Stuck states and time bombs

Date: 2026-10-17. Status: accepted. Migrations `20270120100000` to `20270120150000`.

## Context

The platform review (H6, H7, H8, H10, M30, M31, M33, M45, L28) found states with no way out
and things that break on a date:

- When the executor gave up, `wf.request` became `failed` but its subject kept its in-flight
  status. A leave stayed `submitted`: its days still counted as pending and its dates still
  refused a new ask (`LEAVE_OVERLAP`). Production has one, a leave that failed on 16 Oct
  (`HANDLER_ERROR`, `shift_assignment_coming_off`).
- Transient errors (a deadlock, a lock wait, a dropped connection) failed an approved request
  for good after about 2.5 minutes, the same as any other error.
- Only the onboarding loader wrote `hr.leave_balance`: nobody had a balance for 2027, so leave
  for January was refused from today, and nobody added through People had one at all.
- `audit.ensure_partitions(2)` ran once, at migration: from January 2027 audit rows go to
  `audit.log_default`, which then blocks making that month's partition.
- `wf.escalate_overdue` was only called by tests: an approval waited forever for an approver on
  leave or one who had left.
- The tasks tick ran every customer's rounds, expiry alerts and licence reminders in one
  transaction: one customer's bad template stopped everyone's, every 5 minutes. The nightly job
  stopped at its first failed step.
- Leave was compared with the calendar date a shift ends on, so leave from Tuesday took the
  Monday 19:00-04:00 shift. Publish turned waiting changes into live shifts without asking the
  roster rules again.
- A test customer's import of file 25 failed the whole dry run with `LEAVE_CONFLICT` when
  someone had approved leave on a day in it.

## Decision

1. **A failed request lets go** (`wf.after_failure`, called by `wf.record_failure` when a row
   fails for good). It hands the request to its module's hook:
   - HR (`hr.on_failed`): leave, swap, role change and deactivation become `failed`, a new
     terminal status on each table. A failed leave frees its days and dates, reads "It could
     not go through. You can ask again." and stays on Team → Leave. The person is told
     (`leave_failed`, `swap_failed` to both people, `access_failed` and `deactivation_failed` to
     whoever asked).
   - Inventory (`inv.on_failed`): a stock adjustment or an order not yet released becomes
     `cancelled`, the finished state its lists, "on the way" figures and "Order it again"
     already read; the request's own `failed` state says why (the order page and the request's
     story, `inv.now_of`, say "could not go through"). Whoever asked is told (`request_failed`).
     A transfer's request runs only after the goods were sent, so it is left alone and received
     as usual; one never sent is cancelled.
   - A hook that fails is logged as a warning; the failure itself is still recorded.
   - The migration runs the hook for every request that failed before it (the repair).
2. **Transient errors retry for hours.** The executor marks SQLSTATE 40001, 40P01, 55P03,
   08xxx and 57P01-57P03 as transient (`isTransient`); `wf.record_failure(..., p_transient)`
   retries them 12 times, 1, 2, 4, 8, 16 then 30 minutes apart (about four hours), counted in
   `wf.outbox.transient_attempts`, apart from the three tries other errors get.
3. **A missing leave balance is the type's full year.** `hr.leave_available`,
   `hr.leave_balances` and `rpt.leave_rows` read a missing row as `annual_days` entitled and
   nothing used; `hr.execute` makes the row, full, the first time leave of that type and year is
   approved. A file 14 row still wins. This was chosen over a yearly job and a row per new
   person because it is always right without anything having to run: a new year, a new person
   and a new leave type all work at once. A person who joins mid-year gets the full year, as
   the loader's rows did; pro-rating is for later.
4. **The audit log's partitions are kept** by `audit.keep_partitions(3)` (SECURITY DEFINER,
   for `wf_executor`), run by the nightly job: this month to three ahead, plus every month with
   rows in the default partition, whose rows are moved into it first.
5. **Approvals move on.** `wf.approvals_tick` runs in the tasks tick: a step past its SLA goes
   up its chain (as `wf.escalate_overdue`), and a step nobody may approve any more
   (`wf.step_has_approver`: every holder inactive, their access ended, or only the asker left)
   goes up at once. One with nowhere to go is counted (`stuck_approvals` in the tick's log) and
   stays in `wf.unroutable_steps`; every chain ends with the account owner, so this needs a
   company with none.
6. **Each customer's tick is its own.** `ops.tasks_tick`, `ops.expiry_alerts`,
   `ops.compliance_tick` (and `inv.apply_par_by_day`) take `p_tenant` (null = everyone, as
   before). `runJobs` (`packages/workflow/src/ticks.ts`) runs each job for each customer
   (`ops.tick_tenants`) in its own transaction; a failure is rolled back, logged with the job
   and customer, and the rest still run. The nightly job runs each step in its own
   transaction the same way. Either exits non-zero when anything failed, so systemd shows it.
7. **A shift is on the day it starts.** `hr.leave_shifts` compares `hr.shift.local_date` with
   the leave's dates, and the leave rule in `hr.assignment_checks` / `hr.assignment_violation`
   the shift's start day.
8. **Publish checks the rules again.** `hr.publish_left_out` lists, in words, the waiting
   changes and draft-shift people (not yet started) who break a rule that can change after
   they were rostered: approved leave that day, or the person has left or moved. Overlap, rest
   and weekly hours are not asked again: each was checked against everyone rostered before, and
   everyone rostered after was checked against it (re-asking them dropped shifts a manager had
   accepted and the test data's recorded history). `hr.publish_week` drops what it lists
   (nobody saw it) and the screen says "Left out, as it breaks a rule now: Pat on Fri 24 Oct
   (on leave)".
9. **A test customer's file 25** leaves out a shift on a day the person has approved leave, with
   a dry-run warning naming the person and the day, instead of failing the import.

## Not done

- An admin "Try again" for a failed request: a failed leave, swap, role change or deactivation
  can now simply be asked for again, and an order ordered again, so it is left for later.
- Showing `wf.unroutable_steps` to admins on a screen: the tick's log counts them; a screen is
  for later.

## Production effect of the repair

The repair runs `wf.after_failure` once for every `wf.request` in state `failed`. It changes
only subjects still in flight: a `submitted` leave, swap, role change or deactivation becomes
`failed`; a `submitted` stock adjustment or order (or a transfer never sent) becomes
`cancelled`; each writes one notification to the person and one audit row. In production that
is the LEAVE request that failed on 16 Oct: its `hr.leave_request` row goes from `submitted` to
`failed` (with `decided_at`), its days stop counting as pending, its dates can be asked for
again, and its person gets "Your leave could not go through". Nothing else changes: requests
already rejected, cancelled or completed are not touched, and no balance, shift or stock row
is written.
