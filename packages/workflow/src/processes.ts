import type { ProcessDef } from './types';

// The six MVP processes (docs/LLD.md section 4, ADR 003). Synced into wf.process_def by
// `pnpm db:seed`. Approve rights per step live in core.bp_policy (seed 002_workflow.sql).

export const STOCK_ADJUSTMENT: ProcessDef = {
  type: 'STOCK_ADJUSTMENT',
  subject: 'inv.stock_adjustment',
  domain: 'STOCK_ADJUSTMENTS',
  hierarchy: 'delivery',
  steps: [
    // variance value above the threshold needs the outlet manager
    {
      step: 'outlet_approval',
      group: 'OUTLET_MANAGER',
      scope: 'subject_node',
      when: { amount_gt: 5000 },
      escalateTo: 'AREA_MANAGER', // SLA escalation and SoD fallback
    },
  ],
  onApproved: 'inv.stock_adjustment.post',
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

// Two-sided: dispatch is scoped to payload.from_node_id (hub), receipt to payload.to_node_id.
export const TRANSFER: ProcessDef = {
  type: 'TRANSFER',
  subject: 'inv.transfer',
  domain: 'TRANSFERS',
  hierarchy: 'delivery',
  steps: [
    { step: 'dispatch', group: 'HUB_MANAGER', scope: 'from_node' },
    { step: 'receipt', group: 'OUTLET_MANAGER', scope: 'to_node' },
  ],
  onApproved: 'inv.transfer.post',
  onRejected: 'inv.transfer.reject',
  slaHours: 24,
};

export const LEAVE: ProcessDef = {
  type: 'LEAVE',
  subject: 'hr.leave_request',
  domain: 'LEAVE',
  hierarchy: 'org',
  steps: [
    {
      step: 'outlet_approval',
      group: 'OUTLET_MANAGER',
      scope: 'subject_node',
      escalateTo: 'AREA_MANAGER',
    },
    { step: 'hr_approval', group: 'HR_ADMIN', scope: 'nearest_ancestor' },
  ],
  onApproved: 'hr.leave.apply',
  onRejected: 'hr.leave.reject',
  slaHours: 48,
};

export const SHIFT_SWAP: ProcessDef = {
  type: 'SHIFT_SWAP',
  subject: 'hr.shift_swap',
  domain: 'SHIFT_SWAPS',
  hierarchy: 'org',
  steps: [{ step: 'outlet_approval', group: 'OUTLET_MANAGER', scope: 'subject_node' }],
  onApproved: 'hr.shift_swap.apply',
  slaHours: 24,
};

export const ROLE_CHANGE: ProcessDef = {
  type: 'ROLE_CHANGE',
  subject: 'core.role_assignment',
  domain: 'SECURITY_ROLES',
  hierarchy: 'org',
  steps: [{ step: 'security_approval', group: 'SECURITY_ADMIN', scope: 'nearest_ancestor' }],
  onApproved: 'core.role_change.apply',
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
