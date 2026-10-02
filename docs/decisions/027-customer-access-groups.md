# 027 — Customer-specific access groups

Status: accepted · 2026-10-02

UX review finding U-28, step AC-1. Until now access groups were product code: the same in
every company, rewritten on every deploy (ADR 009). A company could give one person extra
access, or change which groups a job role gets, but not change what a group allows.

- **Migration** (forward-only): `20261021100000_custom_groups`.
- **Product sync:** now leaves a company's own groups and their rights alone.

## What a company can build

A **custom group** is a set of the product's business rights, each at "see" or "change",
for that company only. For example, "Kitchen Lead" = change rosters, tasks and checklists;
see attendance, leave and shift swaps.

- **Business rights only.** Never admin rights (users and access, company settings,
  security roles, approval settings) or company reports. A trigger refuses them whoever
  writes the row.
- **Its own code.** It can't take a product group's code. If a later release adds a product
  group with the same code, the deploy's sync stops and names it, rather than merging them.
- **Where it applies.** A right applies where the group is given, as for any group: stock
  rights at a store, people rights at a department or outlet.

## Requests and approvals

Decided on 2 Oct: someone given extra access must be able to do those duties, including
approving and rejecting. So a custom group can **carry the request and approval duties of
product roles** (`acts_as`), for example "approves like a Department Head".

- **How.** Wherever the workflow looks for holders of a role at a place (the four
  functions `core.group_holders`, `core.site_group_holders`, `core.nearest_group_node`,
  `core.site_group_node`), holders of a custom group carrying that role count too
  (`core.acting_groups`).
  - Requests reach them in Inbox and they can act on them.
  - They can start the requests that role starts (bp_policy is checked through the same
    holders).
  - Nobody approves their own request, as before (rule 7).
- **Which roles.** Business roles only. Never Account Owner, User Admin, the AI agent, or
  the security roles: Security Admin approves sensitive grants, and Auditor reads the
  access audit.
- **The bottom nav** treats the carried roles as the person's kind of work, so a kitchen
  lead gets a department head's nav.

## Sensitive groups

Giving a sensitive group needs approval (ADR 011). A custom group is sensitive when it:

- includes pay;
- carries a sensitive role's duties (Outlet Manager, HR Admin, Outlet HR);
- or includes a right, at that level, that only sensitive product groups have, such as
  changing worker records.

Kitchen Lead is not sensitive: a department head has every one of its rights.

## Who builds them

Decided on 2 Oct: the Account Owner, or a platform admin.

- **The Account Owner, in Admin → Access groups.** `core.save_custom_group` checks
  COMPANY_SETTINGS modify at the company.
  - **Editing** applies at once to everyone holding the group. The form says how many
    people that is first.
  - **Removing** is allowed only while nobody holds it and no job role uses it
    (`GROUP_IN_USE`); its rights go with it, and it can't be given again.
- **A platform admin, through the onboarding file `05_access_groups.csv`.** One row per
  group: code, name, rights (`DOMAIN:view; DOMAIN:modify`), and the roles whose duties it
  carries. The loader writes it through `core.put_custom_group`, which applies the same
  checks. Groups the file doesn't list are left alone (the owner may have built them in the
  app). Files 06 (job roles) and 08 (extra access) may use the file's groups.
- **Everyone else.** User admins see the groups, read-only, and can give them to people
  like any group.

**Every change is audited:** `core.security_group` and `core.domain_policy` carry the audit
trigger.

**Unchanged:** `core.can`. It already read each company's own `domain_policy` rows, so a
custom group's rights apply through the same check as any other (rule 2).

## Test data

Test Company has **Kitchen Lead** (file 05), carrying a Department Head's duties. Sous Chef
1.1 holds it at Hotel 1.1's kitchen (file 08). The expected-access file and the all-users
RLS run cover it.

## Tests

- `custom-groups.db.test.ts`:
  - only the owner builds, and rights apply where given;
  - admin rights, company reports, unknown rights and product codes are refused;
  - admin and security roles can't be carried;
  - the same code in two companies is two groups, and neither company can see or grant the
    other's;
  - sensitivity: pay, a sensitive role, or a right only sensitive groups hold; a sensitive
    grant waits for approval;
  - Kitchen Lead approves the 1.1 kitchen's leave, only where it was given, never its own;
  - changes are audited;
  - a held group can't be removed, and a removed one loses its rights and can't be given;
  - the app can't write the tables directly.
- `product.db.test.ts`: the sync keeps custom groups and stops on a code clash.
- `loader.db.test.ts`: the expected access includes Kitchen Lead; a second load changes
  nothing.
- `custom-groups.test.ts` (unit): the rights and roles offered, codes from names.
- `custom-groups.spec.ts` (e2e):
  - the owner builds a group, sees it offered when granting, and removes it;
  - a user admin sees the groups read-only;
  - Kitchen Lead approves a leave from Inbox.
