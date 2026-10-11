// An outlet's rules for its stores (ADR 115), chosen when the customer is set up: file 02's
// outlet row, or the set-up wizard's Outlets step. The database reads them (inv.stock_rule);
// this is their codes and the words people choose them by. Whether departments ask a Main
// Store or each other is the outlet's shape: a Main Store (the Stores department) or none.

/** Who approves a department's request for stock from another store. */
export const REQUEST_APPROVALS = ['unusual', 'gm', 'none'] as const;
export type RequestApproval = (typeof REQUEST_APPROVALS)[number];

/** Who approves a purchase that needs approving (which ones: `purchase_approval`). */
export const PURCHASE_APPROVERS = ['department_head', 'gm'] as const;
export type PurchaseApprover = (typeof PURCHASE_APPROVERS)[number];

export const REQUEST_APPROVAL_WORDS: Readonly<Record<RequestApproval, string>> = {
  unusual: 'The department head, only when it is more than usual',
  gm: 'The GM, every request',
  none: 'No one: the store sends it',
};

export const PURCHASE_APPROVER_WORDS: Readonly<Record<PurchaseApprover, string>> = {
  department_head: 'The department head',
  gm: 'The GM',
};

/** How departments get stock, from the outlet's shape. */
export function storeSetupWords(hasMainStore: boolean): string {
  return hasMainStore
    ? 'Departments ask the Main Store. It sends what it has and buys the rest.'
    : 'No Main Store: departments ask the department that keeps it (the Bar for beer) and buy the rest themselves.';
}
