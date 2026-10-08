# 074 — Handing a task on: who keeps it in view, and when it was given

Status: accepted · 2026-10-07 · migration 20261130100000

At the Passport Hotel the Executive Housekeeper gave the pest control reminder (a job at the
hotel itself, ADR 073) to her housekeeping supervisor. The task went to the supervisor, and
the screen she was on then said she had no access: a task was seen only by whoever had it,
its job role's people, and those with task access at its place, and hers was the
housekeeping department, not the hotel. It also left her To do list, with nothing to follow
it by; and nothing said when it had reached the supervisor, so a task overdue before it was
given looked like the supervisor's lateness.

## Decision

1. **Who sees a task** (`ops.sees_task`, used by `ops.task_detail` and the compliance
   reminder's page): whoever has it or may take it (its job role or shift); the managers of
   its place (task access there; the GM covers the whole property); **the head of the
   department where its people work**, wherever the task sits (task access over the
   holder's place: a department head answers for everything in the department); **whoever
   handed it on**, through a chain; and for a licence renewal or a compliance job, whoever
   keeps Compliance there or answers for it (`owner_role`, ADR 073).
2. **Who may give it to someone else or take it back** (`ops.may_hand_on`,
   `ops.reassign_task`, any kind of task that is to do, except a reported expired batch,
   which still goes through `ops.assign_expiry`): the same people with modify access, and
   the one who has a licence renewal or a compliance job. Only to someone who works at the
   task's place. Whoever had it is told it was given to someone else.
3. **Every handover is recorded**: `ops.task_handover` (who had it, who has it, who gave it,
   when), written by a trigger on `ops.task`, so every way a task is assigned records it:
   a task made for someone, a delivery or a reminder handed on, a discard given out, a
   covered role's task given by the tasks job (by nobody), and taking a job role's task (by
   the one who took it). `ops.task.assigned_at` is when it reached whoever has it (or its job
   role). Existing tasks got their history from the audit log.
4. **Every list says who has it, since when, and when it is due**: To do ("You, from …"),
   Team tasks ("You" for the manager's own; a department head's list includes their
   people's tasks wherever they sit), Repairs, the Compliance regular jobs, and the task
   page, with its history. A task that was already overdue when it reached someone says so
   ("overdue when given"), so their lateness counts from when they got it.
5. **Given to others**: what someone gave to someone else stays on their To do list and on
   Home until it is done (`ops.my_handed_on`), and they are told when it is done
   (`task_done`; the role that answers for a compliance job hears through
   `compliance_done` instead, once).
6. `ops.can_work` never returns null (it did for someone outside an unassigned task's pool,
   and `not (… or null)` let a check through).
7. **Swaps for management only** (ADR 035, SW-4): with the setting on, staff no longer see the
   Swaps tab or the Swaps entry on Me either, not only the Swap button.

## Consequences

- Access changes for tasks (a department head over their people's tasks, a giver over what
  they gave): the RLS equivalence (all users) workflow runs on it.
- Test Company's pest control is done by the Executive Housekeeper (file 39), as at the
  Passport Hotel, so the case stays in the test data.
- Pinned by `packages/db/src/task-handover.db.test.ts` (every way a task is assigned, the
  people who see it and may move it, and a check that for every user of both test
  customers every task their lists show opens) and `apps/web/e2e/task-handover.spec.ts`.
