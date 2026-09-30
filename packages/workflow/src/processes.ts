import type { ProcessDef } from './types';

// The six MVP processes (docs/LLD.md section 4, ADR 003). Synced into wf.process_def by
// sync-defs (`pnpm db:seed` and every deploy). Every step's chain ends with ACCOUNT_OWNER
// (ADR 009); bp_policy approve rows are derived from the chains (bp-policy.ts).

export const STOCK_ADJUSTMENT: ProcessDef = {
  type: 'STOCK_ADJUSTMENT',
  subject: 'inv.stock_adjustment',
  domain: 'STOCK_ADJUSTMENTS',
  hierarchy: 'delivery',
  steps: [
    // Every adjustment that reaches the workflow needs the outlet manager: count variance
    // beyond the item's tolerance, wastage above the value threshold, supplier excess.
    {
      step: 'outlet_approval',
      group: 'OUTLET_MANAGER',
      scope: 'subject_node',
      escalateTo: 'AREA_MANAGER', // SLA escalation and SoD fallback
    },
  ],
  onApproved: 'inv.stock_adjustment.post',
  onRejected: 'inv.stock_adjustment.reject',
  slaHours: 24,
};

export const PURCHASE_ORDER: ProcessDef = {
  type: 'PURCHASE_ORDER',
  subject: 'inv.purchase_order',
  domain: 'PURCHASE_ORDERS',
  hierarchy: 'delivery',
  steps: [
    {
      step: 'outlet_approval',
      group: 'OUTLET_MANAGER',
      scope: 'subject_node',
      escalateTo: 'AREA_MANAGER', // SLA escalation and SoD fallback
    },
    {
      step: 'area_approval',
      group: 'AREA_MANAGER',
      scope: 'nearest_ancestor', // resolved across trees via core.node_link
      when: { amount_gt: 50000 },
    },
  ],
  onApproved: 'inv.po.release',
  onRejected: 'inv.po.reject',
  slaHours: 24,
};

// Two-sided: dispatch is scoped to the transfer's from node (hub), receipt to its to node.
// Each step is approved by the module RPC that posts its ledger leg (inv.dispatch_transfer,
// inv.receive_transfer); after dispatch the goods are in transit and the request can no
// longer be rejected or cancelled, only received (shortfall posts as transit_loss).
export const TRANSFER: ProcessDef = {
  type: 'TRANSFER',
  subject: 'inv.transfer',
  domain: 'TRANSFERS',
  hierarchy: 'delivery',
  steps: [
    {
      step: 'dispatch',
      group: 'HUB_MANAGER',
      scope: 'from_node',
      approveVia: 'module',
      irreversible: true,
    },
    { step: 'receipt', group: 'OUTLET_MANAGER', scope: 'to_node', approveVia: 'module' },
  ],
  onApproved: 'inv.transfer.post',
  onRejected: 'inv.transfer.reject',
  slaHours: 24,
};

// The person's department head first, falling back up the tree (ADR 009). The HR step is
// a customer setting (leave_hr_approval, on unless turned off); when the same person
// already approved the first step, it is skipped (same_approver).
export const LEAVE: ProcessDef = {
  type: 'LEAVE',
  subject: 'hr.leave_request',
  domain: 'LEAVE',
  hierarchy: 'org',
  steps: [
    {
      step: 'manager_approval',
      group: 'DEPARTMENT_HEAD',
      scope: 'subject_node',
      fallback: ['OUTLET_MANAGER', 'AREA_MANAGER'],
    },
    {
      step: 'hr_approval',
      group: 'OUTLET_HR',
      scope: 'nearest_ancestor',
      fallback: ['HR_ADMIN'],
      when: { setting: 'leave_hr_approval' },
    },
  ],
  onApproved: 'hr.leave.apply',
  onRejected: 'hr.leave.reject',
  slaHours: 48,
};

// Initiated by the partner (B) accepting A's offer. Neither A nor B can approve
// (hr.swap_excluded). Approval goes through hr.approve_swap, which re-runs the rostering
// rules first (ADR 008). Department head first, falling back up the tree (ADR 009).
export const SHIFT_SWAP: ProcessDef = {
  type: 'SHIFT_SWAP',
  subject: 'hr.shift_swap',
  domain: 'SHIFT_SWAPS',
  hierarchy: 'org',
  steps: [
    {
      step: 'manager_approval',
      group: 'DEPARTMENT_HEAD',
      scope: 'subject_node',
      fallback: ['OUTLET_MANAGER', 'AREA_MANAGER'],
      approveVia: 'module',
    },
  ],
  onApproved: 'hr.shift_swap.apply',
  onRejected: 'hr.shift_swap.reject',
  slaHours: 24,
};

export const ROLE_CHANGE: ProcessDef = {
  type: 'ROLE_CHANGE',
  subject: 'hr.role_change',
  // user administration (ADR 009): requested by User Admins and Account Owners
  domain: 'USER_ACCESS',
  hierarchy: 'org',
  steps: [{ step: 'security_approval', group: 'SECURITY_ADMIN', scope: 'nearest_ancestor' }],
  onApproved: 'hr.role_change.apply',
  onRejected: 'hr.role_change.reject',
  slaHours: 24,
};

export const PROCESS_DEFS: readonly ProcessDef[] = [
  STOCK_ADJUSTMENT,
  PURCHASE_ORDER,
  TRANSFER,
  LEAVE,
  SHIFT_SWAP,
  ROLE_CHANGE,
];
