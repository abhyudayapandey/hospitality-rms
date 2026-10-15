/** Whose yes it waits for, in the outlet's words (ADR 145). */
export function approverWords(approver: 'gm' | 'department_head' | null): string {
  return approver === 'gm' ? 'The GM' : 'Your department head';
}

/**
 * The line above the ask and order forms' reasons: who will be asked, and why when the outlet
 * asks for every one. Never names the department head where the GM approves.
 */
export function approvalHeadline(
  c: { approver: 'gm' | 'department_head' | null; rule: 'every' | 'above' | 'unusual' | null },
  kind: 'order' | 'transfer',
): string {
  const who = approverWords(c.approver);
  if (c.rule === 'every') {
    return `${who} approves every ${kind === 'order' ? 'order' : 'request'} here.`;
  }
  return `${who} will be asked to approve this:`;
}
