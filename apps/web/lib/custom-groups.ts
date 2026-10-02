// A company's own access groups (AC-1, ADR 027): what the Admin screen offers. Pure; the
// database (core.save_custom_group) checks every rule again and decides.

import { ACCESS_GROUPS, DOMAINS, DOMAIN_WORDS } from '@outlet-ops/domain';

export type Level = 'none' | 'view' | 'modify';

export interface RightOption {
  code: string;
  words: string;
  /** where a grant must be given for the right to apply */
  where: 'a store' | 'a department or outlet' | 'yourself';
}

/** Business rights only: no admin rights, no company reports. */
export const RIGHT_OPTIONS: readonly RightOption[] = DOMAINS.filter((d) => !d.admin).map((d) => ({
  code: d.code,
  words: DOMAIN_WORDS[d.code] ?? d.code.toLowerCase(),
  where:
    d.tree === 'delivery' ? 'a store' : d.tree === 'self' ? 'yourself' : 'a department or outlet',
}));

/** Roles a custom group can't stand in for: the AI agent and the security roles. */
export const NOT_CARRIABLE: ReadonlySet<string> = new Set([
  'AI_AGENT',
  'SECURITY_ADMIN',
  'AUDITOR',
]);

/** Product roles whose request and approval duties a custom group may carry. */
export const CARRIABLE_ROLES: readonly { code: string; name: string }[] = ACCESS_GROUPS.filter(
  (g) => g.kind === 'role' && !NOT_CARRIABLE.has(g.code),
).map((g) => ({ code: g.code, name: g.name }));

/** "Kitchen lead (night)" → "KITCHEN_LEAD_NIGHT"; a code the database accepts, or ''. */
export function codeFromName(name: string): string {
  const code = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
    .replace(/^[^A-Z]+/, '')
    .slice(0, 40)
    .replace(/_+$/, '');
  return code.length >= 3 ? code : '';
}

/** A product group's code: a custom group can't take it. */
export function isProductCode(code: string): boolean {
  return ACCESS_GROUPS.some((g) => g.code === code);
}

/** The rights the form sends: only those set to view or modify. */
export function rightsPayload(
  levels: Readonly<Record<string, Level>>,
): Record<string, 'view' | 'modify'> {
  const out: Record<string, 'view' | 'modify'> = {};
  for (const r of RIGHT_OPTIONS) {
    const l = levels[r.code];
    if (l === 'view' || l === 'modify') out[r.code] = l;
  }
  return out;
}
