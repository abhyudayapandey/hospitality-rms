// Business-process policy (core.bp_policy): who may initiate each process and which
// groups may approve each step (docs/LLD.md section 4, ADR 003, ADR 009). Product-wide;
// syncProductAccess writes it into every tenant and removes rows not listed here.
// step '*' = process-level actions. SELF = any active human acting on their own subject.
// Every step group and escalateTo group has an approve row (definitions tests).

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
  ...rules('STOCK_ADJUSTMENT', 'outlet_approval', 'approve', ['OUTLET_MANAGER', 'AREA_MANAGER']),

  ...rules('PURCHASE_ORDER', '*', 'initiate', ['STORE_KEEPER', 'OUTLET_MANAGER', 'AI_AGENT']),
  ...rules('PURCHASE_ORDER', 'outlet_approval', 'approve', ['OUTLET_MANAGER', 'AREA_MANAGER']),
  ...rules('PURCHASE_ORDER', 'area_approval', 'approve', ['AREA_MANAGER']),

  // the receiving side requests; the receiving outlet manager confirms receipt (rule 7)
  ...rules('TRANSFER', '*', 'initiate', ['STOCK_USER', 'STORE_KEEPER']),
  ...rules('TRANSFER', 'dispatch', 'approve', ['HUB_MANAGER']),
  ...rules('TRANSFER', 'receipt', 'approve', ['OUTLET_MANAGER']),

  ...rules('LEAVE', '*', 'initiate', ['SELF']),
  ...rules('LEAVE', 'outlet_approval', 'approve', ['OUTLET_MANAGER', 'AREA_MANAGER']),
  ...rules('LEAVE', 'hr_approval', 'approve', ['HR_ADMIN']),

  ...rules('SHIFT_SWAP', '*', 'initiate', ['SELF']),
  ...rules('SHIFT_SWAP', 'outlet_approval', 'approve', ['OUTLET_MANAGER', 'AREA_MANAGER']),

  // user administration: User Admins and Account Owners request sensitive grants
  ...rules('ROLE_CHANGE', '*', 'initiate', ['USER_ADMIN', 'ACCOUNT_OWNER']),
  ...rules('ROLE_CHANGE', 'security_approval', 'approve', ['SECURITY_ADMIN']),
];
