# 164. The restaurant QA walk, round two

Date: 2026-10-16. Status: accepted.

## Context

The owner walked [TEST] Restaurant again with the QA sheet. One finding was a production bug:
approving leave failed in the executor. The rest were screens that said the wrong thing, said
it in the wrong place, or hid it.

## Decision

0. **Leave over a roster change waiting for Publish.** `hr.leave.apply` dropped an assignment a
   manager had taken the person off (`coming_off`, ADR 135), and the check "coming off only while
   assigned" refused the row, so the leave never applied. Every writer that takes an assignment
   off `assigned` (leave, a swap, a cancelled shift, Publish, Start again) had the same trap, so
   the table clears the flag itself: a BEFORE UPDATE trigger on `hr.shift_assignment` sets
   `coming_off = false` whenever the status is no longer `assigned`. One trigger instead of
   fixing each writer, so a writer added later cannot bring it back. The same class for
   `pending` (put on a published shift, waiting for Publish): approved leave now drops those too
   (`hr.leave_shifts`), so Publish never puts someone on a day of leave.
1. **Task lists by the business day.** `ops.team_tasks`, `ops.late_count` and `ops.late_counts`
   took a task's calendar day, so a Lock-up due at 00:00 on the 17th was the 17th's. They now
   keep the tasks due inside the business days' window (04:00 to 04:00 in the outlet's time
   zone, as `rpt.days_window`); `ops.completion`'s week starts on Monday at 04:00. On the web,
   Team tasks' "today" and Home's next tasks (`todaysTasks`) use `businessToday` / `businessDate`.
   This is also why the assistant manager's Lock-up was missing from Home in the evening (AM-02):
   its pool was right, its day was not.
2. **History is always open.** A repair's History and a request's "What happened" are sections
   under their own heading, not folded `<details>`; so are a regular job's "Change the job", a
   licence's "Correct its details" and an order's "Add the bill".
3. **RFMs History is one row a chain.** A request made for an ask shows in the ask's row
   (`inv.root_transfer` → `for_ask_id`) for whoever took part in the ask. An order made for a
   request (or for a supply request) shows in that chain's row for whoever took part in the
   chain, unless they made, placed, closed or received the order: buying is the keeper's own
   work, so the Main Store's keeper sees the request they sent and the order they bought.
   Approving the order is part of the chain, not a row of its own.
4. **The date picker** is the phone's own date box, invisible, laid over the calendar icon at its
   size (its indicator fills the box on a computer). A tap opens the phone's calendar and it
   closes as it always does; the box opened by script (`showPicker`) stayed open on some
   phones. Typing dd/mm/yyyy is unchanged (ADR 162).
5. **Sections given show where they were given and on Home.** They were saved and showed on the
   person's Home, but the giver saw only coloured tiles: Give sections now lists what is given
   ("Section 1 · Jason Pinto", "Not given yet") above the rows, and the manager's Home card lists
   today's sections and who has each (`sectionsToday`).
6. **The till file** may be separated by commas, tabs or semicolons (`separatorOf`: the separator
   that splits the header line most; a semicolon file may write decimals with a comma). The
   messages say it in plain words.
7. **The restaurant demo** has three meters at Engineering for the technician's Utilities and
   shelves for every Main Store item.
8. **"Part received"**: the order desk's "To receive" says when part of an order came already
   (`inv.desk_orders.part_received`).
9. **Excise** is daily work: under My work on Me, never Admin.
10. **Verify stock** shows the proof photo already taken when the verifier comes back to finish.
11. **A tile is tappable all over**: a tile in a grid cell fills its cell (`h-full`), so a short
    tile next to a tall one has no dead space.
12. **Who does what** lists roles under their department at the outlet (`department_name`, from
    `core.cover_home`), the outlet's own roles first.
13. **No Swaps tile on Me** for anyone. Swaps stay in Roster and Shifts & leave (ADR 152).
14. **A leave's pill follows its words.** One state, `hr.leave_state` (submitted, approved,
    rejected, cancelled, failed), decides the words, Team → Leave's pill and the roster's day of
    leave. Approved shows as soon as the last person says yes; "Could not go through" is a red
    pill, and such a leave is no leave on the roster.
15. **Department tiles** on a manager's Home say up to three facts: late rounds first, then what
    waits (repairs, attendance, open shifts), then what runs low. The tile opens its first.
16. **Wastage** shows the list first, each line's cost and a total (only for whoever
    `inv.sees_store_money` lets see it), then the form under "Record wastage" (ADR 051).
17. **An approved order reads approved.** The last yes moved the workflow on at once, but the
    order stayed `submitted` until the executor released it a minute later, so Orders, RFMs
    History and the order's header read "waiting for approval". `inv.purchase_order_summary`'s
    progress is now `approved` in that minute (`inv.po_approved`, from the workflow's state), as
    transfers already did (`inv.transfer_awaits_approval`). Nobody else was waiting: with the GM
    as approver there was no second step.

## Consequences

- `hr.leave_on_day` and `hr.leave_for_day` read `hr.leave_state`: a leave approved by its last
  approver blocks the roster at once (`LEAVE_CONFLICT`), and one that failed blocks nothing.
- `inv.desk_orders` and `core.admin_role_cover` gained a column (recreated with their grants).
- No access changes: every new read is a SECURITY DEFINER function that checks what its caller
  already sees, or a column of one.
