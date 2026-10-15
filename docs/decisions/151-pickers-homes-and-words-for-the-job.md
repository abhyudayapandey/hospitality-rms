# 151. Pickers, Homes and words for the job

Date: 2026-10-15. Status: accepted. Migrations `20261231130000_pickers_who_can_do_it`,
`20261231140000_keeps_main_store`.

## Context

The rest of the re-audit's section 5. Pickers listed everyone: handing a fire extinguisher's
renewal on offered the bartender and the commis, Give rooms offered the executive housekeeper and
the pool attendant, Give sections the restaurant manager, an event's Staff needed all 60+ roles
of the company, Admin → Add access every product group at any place, the logbook the writer
themself. Office roles had an empty Home: the accountant saw the date, HR their own department's
figures, the purchase manager 81 items running low and nothing about orders. Managers read words
written for staff ("report them to your lead", "Ask your chef") and opened Breakage, Training and
Linen on their own office department.

## Decision

1. **A picker lists who can do the job**: Give rooms the roles of the outlet's room rounds, Give
   sections the floor's people and not those who run it (`ops.runs_something`), a licence's or
   calendar job's hand-on its role, the role's usual department and the outlet's managers. An
   event asks for staff from the roles its outlet has (`ops.event_roles`; an event at a
   department asks the whole outlet). Add access offers a group only at places it fits
   (`groupFitsPlace`), a person's home place is never the company, and the logbook never offers
   its writer. Who renews a licence and who answers for a job list the roles that run something
   first (`answering`).
2. **An office Home shows the desk's work** (`lib/desk.ts`, "Your desk"): the accountant bills
   missing and what came in this week, HR the clock-ins to check and who joined in 30 days, the
   auditor the week's access changes where they may read them. Each row is counted from what the
   person can already see and opens its list. An office's Home no longer leads with running low
   or shows its own department's "Today so far".
3. **Whoever keeps a Main Store gets the order desk's tiles** (`inv.keeps_main_store`): the
   purchase manager as well as the store keeper. A department head keeping a department store does
   not.
4. **Words for the reader**: Make's expired batches tell whoever may discard them to record the
   wastage, and only others to tell their lead; a recipe with no method tells its editor to tap
   Change recipe, and a reader nothing more; Profile lists access as short chips under "You can
   change" and "You can see". Breakage, Training and Linen open on the outlet for its managers.

## Consequences

- Pickers narrow; nobody gains access. The RLS all-users run still goes before merging, since the
  pickers read access.
- The auditor's access changes need USER_ACCESS, which the Auditor group does not hold; the
  auditor's Home shows no desk until that is decided.
