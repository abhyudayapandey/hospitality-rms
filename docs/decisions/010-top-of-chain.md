# 010 — Top of chain: an account owner's own requests

Status: accepted · 2026-10-03

ADR 009 made `ACCOUNT_OWNER` the final approver of every step. That left one gap: an
owner's own request where nobody else could approve (rule 7 excludes the requester). The
sole owner of the Test Solo Bar could not take leave; an owner changing the only security
admin's access got `NO_APPROVER`. Requiring a second owner would block every small
customer.

- **Migration:** `20261003100000_top_of_chain` (forward-only).
- **Deploy:** app deploy only (the Deploy workflow). No CDK change.

## Decision

- **Top of chain.** When `wf.submit` finds no approver for a step, and the requester holds
  `ACCOUNT_OWNER`, the step is approved at once with the requester as actor, flagged
  `top_of_chain` and commented "top of chain: no higher approver". The rule applies only
  when nobody else anywhere in the chain could approve. Anyone who is not an account owner
  still gets `NO_APPROVER`.
- **Module steps.** A step approved through its module (transfer dispatch and receipt)
  cannot be approved without doing the work. It stays pending, flagged `top_of_chain`,
  and the owner does it themselves: rule 7 steps aside for that step only.
- **Where it shows.**
  - The request's history: the step row, and "Approved automatically: top of chain, no
    higher approver" on My requests.
  - `core.access_audit`: "approved at the top of the chain", with the process and step in
    the new `note` column.
  - The owner's decisions (`wf.my_decisions`).
- **Sole-owner marker.** Grants a sole owner applied without approval (ADR 009) carry
  "sole account owner: no one else can approve" in the access audit's `note`.
  - The admin screen tells a sole owner that their sensitive grants apply at once and
    that adding a second account owner turns approvals on
    (`core.is_sole_account_owner()`). With a second owner, both rules stop applying.
- **Loader warnings.** `wf.people_without_approver(tenant)` lists everyone who could start
  a request (their `SELF` requests at home, and every place their initiating groups
  cover) that nobody else could approve. The loader reports one warning per person and
  process in the dry run. These warnings do not block a load: an owner's request is
  approved at the top of the chain, and anyone else's would get `NO_APPROVER`. The
  sending side of a transfer depends on where it comes from and is not checked.
  - Test Company: the account owner's own leave and swaps.
  - Test Solo Bar: the owner, for every process they can start.

## Also fixed

- **Same approver.** `wf.advance` no longer skips a module step as `same_approver`.
  Anyone who could act on both dispatch and receipt would have skipped the receipt, and
  the goods would have stayed in transit: an outlet manager running both stores, or the
  owner here. Receipt now always posts through `inv.receive_transfer`.
