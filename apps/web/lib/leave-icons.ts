// A picture for each kind of leave (ADR 107), from its code or name, so a customer's own types
// get one too: sick leave a first-aid kit, casual leave an umbrella, earned leave a palm tree,
// a compensatory off a day each way; anything else the calendar. Pure, for tests.

import type { IconName } from '@/components/icon';

const RULES: readonly [RegExp, IconName][] = [
  [/sick|medical|illness/i, 'medkit'],
  [/comp(ensatory)?[\s_-]*off|\bcomp\b|lieu/i, 'compOff'],
  [/earned|privilege|annual|vacation|holiday/i, 'palm'],
  [/casual/i, 'umbrella'],
  [/maternity|paternity|parental|child/i, 'people'],
  [/unpaid|without pay|\blwp\b/i, 'rupee'],
];

export function leaveIcon(codeOrName: string, name = ''): IconName {
  const words = `${codeOrName.replaceAll('_', ' ')} ${name}`;
  return RULES.find(([re]) => re.test(words))?.[1] ?? 'calendar';
}

/** A request's status in words, never its code (CLAUDE.md). */
export const LEAVE_STATUS: Readonly<Record<string, string>> = {
  submitted: 'Waiting for approval',
  approved: 'Approved',
  rejected: 'Not approved',
  cancelled: 'Cancelled',
  draft: 'Draft',
};
