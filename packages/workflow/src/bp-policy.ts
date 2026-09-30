// Business-process policy (core.bp_policy): who may initiate each process and which
// groups may approve each step (docs/LLD.md section 4, ADR 003, ADR 009). Product-wide;
// syncProductAccess writes it into every tenant and removes rows not listed here.
// step '*' = process-level actions. SELF = any active human acting on their own subject.
// Approve rows are derived from the process definitions: every group of every step's
// chain (group, escalateTo, fallback, ACCOUNT_OWNER) may approve that step.

import { PROCESS_DEFS } from './processes';
import { chainGroups } from './types';

export interface BpRule {
  process: string;
  step: string;
  group: string;
  action: 'initiate' | 'approve' | 'cancel' | 'view';
}

const rules = (process: string, step: string, action: BpRule['action'], groups: string[]) =>
  groups.map((group): BpRule => ({ process, step, group, action }));

export const BP_POLICY: readonly BpRule[] = [
  ...rules('STOCK_ADJUSTMENT', '*', 'initiate', [
    'STOCK_USER',
    'STORE_KEEPER',
    'HUB_MANAGER',
    'OUTLET_MANAGER',
  ]),

  ...rules('PURCHASE_ORDER', '*', 'initiate', ['STORE_KEEPER', 'OUTLET_MANAGER', 'AI_AGENT']),

  // the receiving side requests; the receiving outlet manager confirms receipt (rule 7)
  ...rules('TRANSFER', '*', 'initiate', ['STOCK_USER', 'STORE_KEEPER']),

  ...rules('LEAVE', '*', 'initiate', ['SELF']),

  ...rules('SHIFT_SWAP', '*', 'initiate', ['SELF']),

  // user administration: User Admins and Account Owners request sensitive grants
  ...rules('ROLE_CHANGE', '*', 'initiate', ['USER_ADMIN', 'ACCOUNT_OWNER']),

  ...PROCESS_DEFS.flatMap((d) =>
    d.steps.flatMap((s) => rules(d.type, s.step, 'approve', chainGroups(s))),
  ),
];
