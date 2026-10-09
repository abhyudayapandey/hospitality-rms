# 020 — Tasks, checklists, prep lists, maintenance and expired batches (Prompt 11b)

Status: accepted · 2026-10-02

Outlets ran their daily work on paper: opening and closing checklists, fridge
temperatures, "make 2 kg of chutney", "the dishwasher leaks". Nothing reminded anyone, and
nobody could see what was done. An expired batch was thrown away by whoever noticed it,
with no record of who made it or whether a new one was made.

- **Migration** (forward-only): `20261015100000_tasks`.
- **Deploy:** a stack change first (photo lifecycle, instance-role statement), then the
  Deploy workflow (migration, a new timer), then re-import both test customers
  (`docs/deploy.md`).

## Three domains

| Group           | TASKS  | CHECKLIST_TEMPLATES | MAINTENANCE |
| --------------- | ------ | ------------------- | ----------- |
| SELF            | modify | –                   | modify      |
| STAFF           | –      | –                   | view        |
| SUPERVISOR      | modify | view                | –           |
| DEPARTMENT_HEAD | modify | modify              | modify      |
| OUTLET_MANAGER  | modify | modify              | modify      |
| AREA_MANAGER    | view   | view                | view        |
| AI_AGENT        | view   | view                | view        |

- All three are on the people tree, at the task's place.
- SELF gives each person their own tasks (owner: the assignee) and the requests they
  raised (owner: the reporter).
- STAFF view on MAINTENANCE is the department's queue: an Engineering technician sees
  the requests Engineering handles.
- Every table is `rpc_only`: the app writes through `ops.*` functions that check
  `core.can()` or the assignee and raise stable codes (rules 1 and 2).

## Tasks

- **Kinds.** One-off, checklist (an instance of a template), prep, and expiry (an expired
  batch).
- **Who a task is for.**
  - A person.
  - A job role at the place: everyone in the role who works there sees it.
  - Whoever is on shift there when it is due (published roster).

  For the last two, the first to start the task takes it; the others get `TASK_TAKEN`.
  `ops.my_tasks()` lists pooled tasks for the people in the pool. RLS can't, because the
  pool isn't an owner column.

- **Steps.** Tick, number with an acceptable range, text, and photo; any step may also
  need a photo. A reading outside its range is **flagged** and the leads are told.
  Prep and expiry tasks also have system steps: record the batch, and discard. These are
  done only through their own functions.
- **Who gives out tasks.** Supervisors and department heads in their department, outlet
  managers anywhere in the outlet. A task can only go to someone who works there
  (`INVALID_ASSIGNEE`).

## Checklists and the tasks job

- **Templates.** A template holds a schedule and the steps, at a place.
  - Schedules: daily at times; some weekdays at times; or every N hours within a window,
    where a `to` before `from` runs past midnight.
  - Times are local to the place.
- **`outlet-ops-tasks-tick`.** A systemd timer runs `ops.tasks_tick()` every 5 minutes
  as `wf_executor`. Each run does three things:
  - Creates the instances due in the next 24 hours. This is idempotent: one task per
    template and due time.
  - Reminds the assignee or pool 30 minutes before the due time.
  - Escalates overdue tasks. At the due time it tells whoever assigned the task. An hour
    later it tells the place's lead: the department head, else the outlet manager,
    walking up the tree.
- **Stopping a checklist.** Archiving a template cancels its future instances that
  nobody has started.
- **Templates are customer data.** They load from a normal onboarding file
  (`29_checklist_templates.csv`), not a test-only one, so a real customer can bring their
  own.

## Prep lists

- **What to make.** The suggestion for each item made at a store is: par + what events in
  the next 48 hours need − what is on hand and not expired − what open prep tasks will
  still make.
- **Prep tasks.** Each chosen line becomes a prep task for the team linked to the store.
  The task is done by recording the batch through the normal production rules. The batch
  carries `task_id`.
- **Partial batches.** A smaller batch leaves the task in progress until the batches
  reach the target.

## Maintenance

- **Raising a request.** Anyone may raise one where they work, with a photo if they like.
- **Who handles it.** The outlet's Engineering department (code `<outlet>-ENGINEERING`)
  handles it. Without one, the outlet does: its outlet manager. The leads there are told.
- **Statuses.** Open → assigned (by a MAINTENANCE modify holder there) → in progress (the
  assignee) → done.
- **Closing.** Done needs a photo of the fix, taken where the request is handled, and
  only the assignee may close it.

## Expired batches

1. **Report.** Anyone who sees the batch on Production taps **Report**. This creates one
   `expiry` task per batch, in status `reported`, and tells the lead. Reporting twice
   returns the same task.
2. **Assign.** The lead (department head, else outlet manager) sees it under **Inbox → To
   assign**. They give the discard to someone in the department, and choose whether a
   remake is needed (the lead's choice).
3. **Discard.** The assignee throws the batch away. This records **expired wastage
   through the normal wastage path** (`inv.post_wastage`), linked to the task.
4. **Over the store's limit.** The discard still needs a photo and the outlet manager's
   approval (rule 4).
5. **Remake.** If asked for, the remake is a production batch linked to the task.
6. **The trace.** `inv.expired_wastage` reads line by line: batch → expiry → report →
   discard → remake. It is the cost report's **Expired** line, and it is what AI batch
   sizing will learn from (rule 6: the agent views TASKS).

### The lead initiates the over-limit discard

`wf.submit` requires the initiator to hold STOCK_ADJUSTMENTS modify, and a commis does
not. So a discard above the limit is submitted in the name of the person who assigned it
(`p_submitter`). The lead decided the discard, and the approval request reads "from" them.

- The commis is still the one who recorded the wastage (`created_by` on the wastage
  lines), and the audit log keeps both.
- ADR 021 adds the commis to the request itself and to its audit rows ("for the commis,
  by the system, on behalf of the lead").
- The approver is the outlet manager, as for any wastage. Rule 7 holds: the initiator is
  the lead, and they cannot approve it.

## Photos

Task photos go to the same private bucket under new prefixes.

| Prefix           | What                                                      | Kept                        |
| ---------------- | --------------------------------------------------------- | --------------------------- |
| `tasks/routine/` | step photos (and a task's own photos, ADR 079)            | 30 days (90 before ADR 079) |
| `tasks/keep/`    | a flagged step's photo (copied), maintenance photos       | 400 days                    |
| `wastage/`       | the discard of an expired batch (as all wastage, ADR 006) | as now                      |

- **Presigning.** The server presigns an upload only after `ops.can_upload_photo(purpose,
node)` says the person works on a task there, a request there, or the discard.
- **Key checks.** Each function that takes a key accepts only that tenant and node's
  prefix (`INVALID_PHOTO`).
- **Instance role.** The new `TaskPhotos` statement allows Get and Put on `tasks/*` and
  nothing else. CopyObject, used to keep a flagged photo, needs only those two.

## Screens and the bottom nav

**Tasks** has these screens:

- Mine (overdue first)
- task detail
- new task
- Team: today's tasks and completion per department, this week and last
- Checklists
- Prep list
- Maintenance

The place switcher (ADR 016) gains five screens:

| Screen        | Places listed: team places and outlets where the person |
| ------------- | ------------------------------------------------------- |
| `tasks`       | views TASKS                                             |
| `tasks_new`   | modifies TASKS                                          |
| `checklists`  | views CHECKLIST_TEMPLATES                               |
| `maintenance` | views MAINTENANCE                                       |
| `report`      | works there                                             |

The app can't read people or places directly, so the lists come from SECURITY DEFINER
functions. These show the rows RLS shows, and the security tests compare the two:

- `ops.maintenance_requests` also shows requests assigned to the person;
- `ops.checklists`.

**The bottom nav has at most five items.** They are chosen by the kind of work the person
does, read from their access groups (`core.my_access()`), then filtered by what they can
open. Everything else is linked from Home.

| Kind of work                                                 | Bottom nav                                      |
| ------------------------------------------------------------ | ----------------------------------------------- |
| Outlet or area (outlet, area, hub manager)                   | Home, Inbox, Stock, Roster, Tasks               |
| Department (head, supervisor)                                | Home, Inbox, Tasks, Roster, Stock or Requests   |
| Store keeper                                                 | Home, Inbox, Stock, Tasks, Roster               |
| Cost controller                                              | Home, Inbox, Stock, Menu, Requests              |
| Frontline (staff, production team, stock user; no approvals) | Home, Tasks, Production or Stock, Roster, Inbox |
| Office (HR, administrators, auditors)                        | Home, Inbox, Admin or Roster, Requests          |

An e2e test pins one row per role from the approved table. It also signs in as every
user of both test customers to check that nobody gets more than five items.

## Test data

- **File 29** (normal): checklists.
  - Hotel 1.0: Kitchen, Bar, Front Office and Housekeeping.
  - Bar 3.0: Kitchen and Bar.
  - Solo Bar: Kitchen and Bar.
- **Files 30 to 32** (test customers only, as ADR 017):
  - 30: five one-off tasks, one of them overdue;
  - 31: one open maintenance request;
  - 32: a prep list matching file 26's batches, plus one open for the load day.
- **Production already has files 26 to 28.** There, file 32 counts its days from the day
  those were loaded, worked out from the batches' keys, and links the batches already
  there.
- **README figures.** The README's expected figures are pinned by
  `test-data-activity.db.test.ts`.
