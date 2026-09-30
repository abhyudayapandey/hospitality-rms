# 008 — Workforce: rostering, attendance, leave, swaps, events

Status: accepted · 2026-09-30

This ADR records how LLD section 5 (Rostering, Attendance, Leave, Events) and its rows
in section 7 were built, with the LEAVE, SHIFT_SWAP and ROLE_CHANGE processes.

- **Migrations** (forward-only, on top of the deployed schema):
  - `20260930140000_wf_excluded_approvers` (workflow engine, shared security functions)
  - `20260930150000_workforce_schema` (tables, directory view, resolvers)
  - `20260930160000_rostering`
  - `20260930170000_leave_swap_role_change` (request functions, `hr.execute`)
  - `20260930180000_attendance` (clock, nightly job)
  - `20260930190000_events_notifications`
- **Dev seed:** `seed/dev/004_workforce_dev.sql`. The inventory dev seed moved to
  `seed/dev/` too, and `db:seed` applies `seed/` and then `seed/dev/`.
- **Screens:** `/roster/*`, `/leave`, `/events`, `/notifications` in `apps/web`.
- **Deploy:** app deploy only (the Deploy workflow). No CDK change, no new AWS resource.

## People data

- **`hr.worker` links to `core.app_user`** through `owner_user_id`, one worker per user.
  That column is the owner for the SELF rules. The worker's name is the user's
  `display_name`.
- **Sensitive data** lives in `hr.worker_sensitive` under `COMPENSATION`, audited
  `names_only`: the log keeps which fields changed, never the values.
- **Data minimisation (DPDP Act 2023).**
  - `hr.worker_sensitive` holds only an optional pay rate and basis. Bank and identity
    document references are left out until the payroll export (Phase 2) needs them.
  - Raw clock-in coordinates are nulled after 90 days by the nightly job. The distance
    and the inside/outside flag stay, so attendance history keeps its meaning.
- **Worker directory.** `hr.worker_directory` is a view with only display name, role
  code and org node.
  - It shows active workers at nodes where the caller has `ROSTER` view (the ADR 007
    node set, from `core.can()`), plus the caller's own row.
  - This lets staff pick a swap partner without `WORKERS` access.
  - It is deliberately not `security_invoker`. A test checks that its rows equal
    `core.can('ROSTER', 'view', …)` for every user, and that STAFF sees nothing else of
    a worker.
- **Configuration is data, not constants.**
  - `hr.roster_setting` holds the rostering rules per tenant: minimum rest (default
    10 h), weekly hours cap (48 h) and late threshold (10 min). No row means the
    defaults.
  - `hr.node_setting` holds each outlet's geofence: latitude, longitude and radius
    (default 150 m).
- **Time.** Shifts store `local_date` and `timestamptz` bounds, computed from the node's
  IANA timezone (Asia/Kolkata for the pilot).
  - Templates hold local times. An end earlier than the start means the shift ends the
    next day.
  - Weeks run Monday to Sunday in local time.

## Rostering rules

`hr.assignment_violation` is the single rule function. `hr.assign`, the candidate list,
swap acceptance, swap approval and the swap executor handler all use it. The codes are:

| Code                 | Rule                                                                               |
| -------------------- | ---------------------------------------------------------------------------------- |
| `WORKER_NOT_AT_NODE` | The worker's home node is another node. There is no cross-outlet cover in the MVP. |
| `ROLE_MISMATCH`      | The worker's role code differs from the shift's.                                   |
| `SHIFT_OVERLAP`      | The shift overlaps another assigned shift.                                         |
| `REST_RULE`          | There would be less than the configured rest between shifts.                       |
| `LEAVE_CONFLICT`     | There is approved leave on a local date the shift touches.                         |
| `WEEKLY_HOURS_CAP`   | The local week's hours would pass the cap.                                         |

`hr.assign` adds `SHIFT_FULL` and `SHIFT_STARTED`. Changes for one worker are
serialised with an advisory lock, so two managers cannot both pass the rest or cap
check.

**Publishing** flips a node-week's draft shifts to published and notifies each assigned
worker once. Assigning or removing people after publishing notifies the affected
worker.

## Leave

- **Days are calendar days, inclusive, for the MVP.** A Saturday-to-Monday request
  counts 3 days, weekly offs included. Counting that knows about weekly offs needs a
  weekly-off calendar per worker and is **Phase 2**. The form and the approval screen
  say "calendar days".
- **The balance check at request time** is `entitled − used − pending`, with the other
  submitted requests counted as pending. It runs under a per-worker advisory lock.
  - Leave types with no annual days (unpaid) have no balance.
  - A request cannot cross a year end (`LEAVE_SPANS_YEAR`) or overlap the worker's own
    submitted or approved leave.
- **Approval** goes to the outlet manager and then HR.
  - Before deciding, the approval screen shows the worker's balance and the assigned
    shifts that approval will drop (`hr.leave_conflicts`).
  - The executor adds the days to `used_days`, re-checking the balance as a safety net,
    and drops the overlapping assignments (reason `leave`).
  - It notifies the worker, and the node's managers when shifts need cover.
  - Approved leave is the "block" that rostering reads (`LEAVE_CONFLICT`); there is no
    separate block table.

## Shift swaps

- **Flow.** Worker A offers a published, future shift to colleague B, who has the same
  role at the same node, and B is notified. **B accepting submits `SHIFT_SWAP` with B
  as initiator**, so B has agreed before a manager sees it. A can withdraw until then.
  B reads offers through `hr.my_swaps()`, because the row belongs to A.
- **Neither party approves.** This uses the new excluded approvers, described below.
  The step escalates to `AREA_MANAGER` when the only outlet manager is a party.
- **Business rules fail at approval, not in the executor.**
  - `SHIFT_SWAP` is `approveVia: 'module'`. `hr.approve_swap` re-runs the rules for B
    first and raises the code to the approver (for example `REST_RULE`), leaving the
    request in approval.
  - The executor re-checks as a safety net only.

## Workflow engine changes

- **Excluded approvers.** A subject type can register an `excluded_resolver`,
  `(uuid) returns uuid[]`, in `core.subject_resolver`.
  - `wf.submit` stores the list on `wf.request.excluded_approvers`.
  - Routing, escalation and `wf.can_act_on_step` skip those users exactly like the
    initiator (rule 7), with the same fallback: the step's own group, then
    `escalateTo`, then the same group higher up the tree.
  - Swaps exclude both parties. A role change excludes the person whose access changes.
- **Self-service ownership.** For SELF processes, `wf.submit` passes the caller as the
  owner to `core.can()`, so any user could have submitted another user's draft. The
  LEAVE resolver now makes a draft submittable only by its owner, and the SHIFT_SWAP
  resolver only by the partner. Tested.
- **Business-rule failures are final.**
  - The executor passes `p_final` to `wf.record_failure` when a handler raises a code in
    `BUSINESS_RULE_CODES` (`@outlet-ops/domain`): the rostering codes,
    `INSUFFICIENT_STOCK`, `INSUFFICIENT_LEAVE_BALANCE`, `TENANT_MISMATCH` and
    `INVALID_STATE`.
  - The outbox row and the request fail after one attempt, and
    `wf.request.failure_code` keeps the code.
  - Anything else (lost connection, deadlock, a bug) is still retried up to 3 times.
- **ROLE_CHANGE** now has its own subject, `hr.role_change` (grant, or end an
  assignment), instead of `core.role_assignment`. That gives it generated RLS and the
  audit trigger like any business table.
  - `hr.request_role_change` (HR Admin) routes to the Security Admin.
  - The executor writes `core.role_assignment`, where the same-tenant trigger still
    applies.
  - There is no cache to refresh: `core.effective_access` is a view computed per query,
    so new access applies to the user's next request.
  - Database only; there is no UI yet.
- **Status changes outside workflows.** Publishing a week, resolving an exception,
  cancelling an event and answering a swap offer change status inside the module's
  `SECURITY DEFINER` function, as the LLD's `hr.publish_week` does. These are not
  workflow subjects. Workflow subjects (leave, swap, role change) change status only
  through `wf.submit`, `wf.act` and the executor (rule 4).

## Attendance

- **Online first.** `hr.clock` uses the server time, is idempotent on the device's key,
  and links the punch to the worker's published shift running from 2 h before its start
  to its end.
- **Geofence.** The distance to the home node's fence is recorded.
  - A punch outside the radius, or with no location, is recorded and raised as an
    exception (`outside_geofence`, `no_location`). It is never blocked.
  - Without a fence configured, the punch gets no flag.
- **Offline queue.** A punch that cannot reach the server is kept in IndexedDB, per
  user, with its tap time and key.
  - It is replayed oldest first with `source = offline` on load, when the device comes
    back online, and every minute.
  - The server keeps the device time if it is at most 24 h old and not in the future;
    otherwise it returns `INVALID_TIMESTAMP`, and the device drops the punch and tells
    the user.
  - A network failure stops the replay run, so punches stay in order.
- **Nightly job.** `hr.nightly_attendance` looks at the last 2 local days per node and
  is idempotent (a unique key per kind, phase, shift and punch). It raises:
  - `late`: after the tenant's late threshold
  - `no_show`
  - `missing_clock_out`: 4 h after the shift, or 16 h after an unrostered punch
  - `unscheduled`
- **Where the job runs.** A **systemd timer** on the instance (02:15 Asia/Kolkata,
  `Persistent=true`), as `outletops-wf` / `wf_executor`, like wf-execute. The
  production image has pg_cron, but local and CI Postgres don't, so a migration that
  scheduled a cron job would not apply everywhere. The timer ships in the release
  bundle, so this is not a CDK change.
- **Exceptions queue.** Managers with `ATTENDANCE` modify resolve or dismiss exceptions
  with a note. Their own exceptions go to someone else (`SEGREGATION_OF_DUTIES`).

## Events

- Events are org-tree rows (`EVENTS` domain) with a time window, covers and a status.
- Requirement lines are either items with a quantity, or roles with a headcount and a
  time window. Edits archive the old lines and write new ones, so the AI layer's
  `EVENT_UPLIFT` signal can read both the current and the historical requirements.

## Notifications

- In-app only: `ops.notification`, readable only by its recipient (an owner-only
  domain, `NOTIFICATIONS`).
- The header shows an unread badge, and there is a notifications list.
- Notifications are sent for roster publishes and changes, swap offers and decisions,
  leave decisions, roster gaps after leave, and access changes.
- Web push is Phase 2.

## Shared security functions

- **`core.can_any`**, used by catalogue tables, also counts the SELF group's policy, for
  active human users. Staff need the leave types to request leave. SELF holds no stock
  domain, so items stay hidden from staff.
- **The owner-only RLS leg** now checks `owner = current user` before calling
  `core.can()`, so other people's rows are rejected without a function call. The
  ADR 007 equivalence test, now with workforce rows for every user, proves the result
  is unchanged.

## Performance

The reads were measured with a year of synthetic roster data (about 4,000 shifts,
assignments and punches), as Olivia (outlet manager), Aria (area manager) and Sam
(staff):

| Read                   | Worst |
| ---------------------- | ----- |
| Week roster with names | 27 ms |
| My shifts, 6 weeks     | 16 ms |
| Open exceptions        | 13 ms |
| 30 days of punches     | 12 ms |

Every read stays well under the 200 ms target (ADR 007).

## Known gaps

- There are no admin screens for workers, templates, leave types, rules or geofences.
  The onboarding script sets them (`docs/deploy.md`).
- There is no cross-outlet cover, no half-day leave, and approved leave cannot be
  cancelled.
- ROLE_CHANGE has no UI; its inbox step is approved inline.
- Leave balances roll over by seeding next year's rows. There is no carry-forward rule.
