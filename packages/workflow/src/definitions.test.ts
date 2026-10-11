import { describe, expect, it } from 'vitest';
import { HANDLERS, INVENTORY_HANDLERS } from './handlers';
import { LEAVE, PROCESS_DEFS, PURCHASE_ORDER, TRANSFER } from './processes';
import { chainGroups, FINAL_APPROVER, processDefSchema } from './types';

describe('process definitions', () => {
  it('has the six MVP processes and deactivation (ADR 035)', () => {
    expect(PROCESS_DEFS.map((d) => d.type).sort()).toEqual([
      'DEACTIVATION',
      'LEAVE',
      'PURCHASE_ORDER',
      'ROLE_CHANGE',
      'SHIFT_SWAP',
      'STOCK_ADJUSTMENT',
      'TRANSFER',
    ]);
  });

  it.each(PROCESS_DEFS.map((d) => [d.type, d] as const))('%s is valid', (_type, def) => {
    expect(() => processDefSchema.parse(def)).not.toThrow();
  });

  it('has a handler for every onApproved/onRejected', () => {
    for (const d of PROCESS_DEFS) {
      expect(HANDLERS[d.onApproved], d.onApproved).toBeTypeOf('function');
      if (d.onRejected) expect(HANDLERS[d.onRejected], d.onRejected).toBeTypeOf('function');
    }
  });

  it('runs real (not stub) handlers for the three inventory processes', () => {
    const inventory = PROCESS_DEFS.filter((d) => d.subject.startsWith('inv.'));
    expect(inventory.map((d) => d.type).sort()).toEqual([
      'PURCHASE_ORDER',
      'STOCK_ADJUSTMENT',
      'TRANSFER',
    ]);
    for (const d of inventory) {
      for (const h of [d.onApproved, d.onRejected]) {
        expect(h && HANDLERS[h], h).toBe(h && INVENTORY_HANDLERS[h]);
        expect(h, d.type).toBeDefined();
      }
    }
  });

  it('has orders approved by the department head (or the GM) only when the rules say, and no value limit (ADR 049, 115)', () => {
    expect(PURCHASE_ORDER.steps.map((s) => [s.step, s.group, s.when])).toEqual([
      ['department_approval', 'DEPARTMENT_HEAD', { payload_true: 'unusual' }],
      // the outlet's rules name the GM as the approver (ADR 115)
      ['gm_approval', 'OUTLET_MANAGER', { payload_true: 'gm' }],
    ]);
    expect(PURCHASE_ORDER.steps[0]).toMatchObject({
      escalateTo: 'OUTLET_MANAGER',
      alsoEscalateTo: true,
    });
  });

  it('puts the department head in front of a request for material when unusual (TR-3)', () => {
    expect(TRANSFER.steps[0]).toMatchObject({
      step: 'approval',
      group: 'DEPARTMENT_HEAD',
      when: { payload_true: 'unusual' },
    });
  });

  it('scopes TRANSFER dispatch to the from node and receipt to the to node; the GM first where the outlet says so (ADR 115)', () => {
    expect(TRANSFER.steps.slice(1).map((s) => [s.step, s.scope, s.when])).toEqual([
      ['gm_approval', 'nearest_ancestor', { payload_true: 'gm' }],
      ['dispatch', 'from_node', undefined],
      // receiving is whoever asked's task now; the step runs for requests raised before
      ['receipt', 'to_node', { payload_true: 'receipt_step' }],
    ]);
  });

  it('rejects unknown keys, duplicate steps and two-sided scopes outside TRANSFER', () => {
    const base = PROCESS_DEFS[0]!;
    expect(() => processDefSchema.parse({ ...base, extra: 1 })).toThrow();
    expect(() =>
      processDefSchema.parse({ ...base, steps: [base.steps[0], base.steps[0]] }),
    ).toThrow();
    expect(() =>
      processDefSchema.parse({ ...base, steps: [{ ...base.steps[0], scope: 'from_node' }] }),
    ).toThrow();
    expect(() =>
      processDefSchema.parse({ ...base, steps: [{ ...base.steps[0], when: { amount_lt: 1 } }] }),
    ).toThrow();
  });

  it('ends every step chain with the account owner; leave goes to the department head, then the GM', () => {
    for (const d of PROCESS_DEFS) {
      for (const st of d.steps)
        expect(chainGroups(st).at(-1), `${d.type} ${st.step}`).toBe(FINAL_APPROVER);
    }
    expect(LEAVE.steps.map(chainGroups)).toEqual([
      ['DEPARTMENT_HEAD', 'OUTLET_MANAGER', 'AREA_MANAGER', 'ACCOUNT_OWNER'],
      ['OUTLET_MANAGER', 'AREA_MANAGER', 'ACCOUNT_OWNER'],
    ]);
  });
});
