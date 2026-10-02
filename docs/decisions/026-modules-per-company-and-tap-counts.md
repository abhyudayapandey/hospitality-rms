# 026 — Modules on or off per company; tap counts

Status: accepted · 2026-10-02

UX review findings U-26 and U-27, step UX-3b. Asked after UX-2: are there too many options
on the screens? Part of the answer is that every company got every module, used or not.

- **Migration** (forward-only): `20261020100000_modules`.
- **No access change.** The product matrix, groups and RLS policies are unchanged.

## Modules (U-26)

A company can switch off any of eight modules. Everything else (stock, roster, tasks,
inbox, reports, admin) is always on.

| Module         | When off, these disappear                                                                  |
| -------------- | ------------------------------------------------------------------------------------------ |
| Events         | Events screens, "Events this week" on My shifts                                            |
| Shift swaps    | Swaps tab, the Swap button on My shifts                                                    |
| Leave          | Leave tab, the Leave link on My week                                                       |
| Production     | Production tab and nav item, batches, expired batches to assign; Prep lists go off with it |
| Prep lists     | Prep list tab                                                                              |
| Checklists     | Checklists tab; the tasks job makes no checklist rounds                                    |
| Maintenance    | Maintenance tab, "Report a problem", repairs to assign, open repairs on Home               |
| Menu and sales | Menu costs, Sales and Variance (Recipes stay); the sales figures in reports and on Home    |

**Where it is kept.** `core.tenant.settings → modules`, for example
`{"events": false}`. A module that isn't listed is on, so existing companies see no change.

**Who changes it.**

- **The Account Owner**, in **Admin → Modules**. `core.set_module(code, on)` checks
  COMPANY_SETTINGS modify at the company, so only the owner can, and only for their own
  company. The tenant's audit trigger records every change. Turning one off asks first.
  Other administrators see the list read-only.
- **At onboarding**, file 00 has a column per module (`events`, `swaps`, `leave`,
  `production`, `prep_lists`, `checklists`, `maintenance`, `menu_sales`; yes or no). A blank
  or missing column leaves the module as it is, so a re-import never undoes the owner's
  choice. Test Solo Bar Co. has Events and Swaps off.

**What "off" means: hidden and refused.**

- **Screens.** The shell leaves the module's domains out of what the screens see
  (`lib/modules.ts`), so its tabs, links, shortcuts and Home cards disappear through the
  same checks that hide anything else. Its pages say "Events isn't switched on for your
  company" (a layout per module).
- **Writes.** Its server actions call `core.require_module(code)` first, in the same
  transaction, which raises `MODULE_OFF`. Leave and swap requests are also refused by a
  trigger on `wf.request`, whatever starts them.
- **Kept.** The data, the access rules and requests already in Inbox: a leave or swap
  waiting for approval can still be decided. Turning a module back on brings everything
  back.

Access decisions still go through `core.can` (rule 2); a module switch is not access, it is
whether the company uses the feature at all.

## Tap counts (U-27)

`e2e/journeys.spec.ts` walks the common jobs from Home, stops at each job's last button
without pressing it, and counts the taps. It fails if a job takes more than its budget.

| Job               | Who             | Taps to get there | Taps in the form | Fields typed |
| ----------------- | --------------- | ----------------- | ---------------- | ------------ |
| Clock in          | Server          | 1 (2 off shift)   | 1                | 0            |
| Open my next task | Commis          | 1                 | 1                | 0            |
| Report a problem  | Commis          | 2                 | 1                | 1            |
| Record wastage    | Store keeper    | 2                 | 2                | 1            |
| Start a count     | Store keeper    | 2                 | 1                | 0            |
| Approve leave     | Department head | 2                 | 1                | 0            |
| Fill an open slot | Department head | 2 (was 4)         | 1                | 0            |
| See today's sales | Cost controller | 0                 | 0                | 0            |
| See my week       | Server          | 1                 | 0                | 0            |

**One fix.** Filling an open slot took four taps (Roster → the day → Assign → the person).
Home's "Needs attention" now has "N open slots this week" for people who build the roster,
linking to the first day with an open slot in a shift that hasn't started.

## Tests

- `modules.db.test.ts`: every module on by default; Test Solo Bar Co.'s Events and Swaps
  off; Prep lists off with Production; only the Account Owner changes modules, for their
  own company, audited; managers, HR, security admin and staff are refused; unknown codes
  refused; `MODULE_OFF` from `require_module` and from a leave request; no checklist rounds
  with Checklists off.
- `loader.db.test.ts`: the file 00 columns are the database's modules; they set modules, a
  blank keeps the owner's choice, a second load writes nothing, a bad value is an issue.
- `modules.test.ts` (unit): which domains each module hides; the Roster tabs and nav
  without them.
- `modules.spec.ts` (e2e): the solo server sees no Swaps or Events; the solo owner turns
  Maintenance off (asked first) and on, and the cook sees it go and come back; the GM sees
  the list read-only.
- `journeys.spec.ts` (e2e): the table above.
