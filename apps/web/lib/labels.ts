// Words for codes that reach a screen (UX-11): an access group is "Department head", never
// DEPARTMENT_HEAD. A customer's own group has a name in its definition; where only the
// code is at hand this is the readable form of it.

import { humanizeCode } from './job-roles';

// groups whose code doesn't read as their name (ADR 149)
const GROUP_NAMES: Record<string, string> = { AI_AGENT: 'Outlet Ops assistant' };

export function groupLabel(code: string | null | undefined): string {
  return code ? (GROUP_NAMES[code] ?? humanizeCode(code)) : '';
}

// the access audit's events (core.access_audit), as a person would say them (ADR 149)
const AUDIT_WORDS: Record<string, string> = {
  granted: 'Access given',
  ended: 'Access ended',
  'user created': 'Person added',
  'user deactivated': 'Person made inactive',
  'user reactivated': 'Person made active again',
  'login enabled': 'Sign-in turned on',
  'login disabled': 'Sign-in turned off',
  'password reset': 'Password reset',
};

export function auditAction(action: string): string {
  return AUDIT_WORDS[action] ?? action.charAt(0).toUpperCase() + action.slice(1);
}

/** Who did it: a change made while setting the company up was the Outlet Ops team's. */
export function auditActor(actor: string): string {
  return actor === 'Platform' ? 'the Outlet Ops team' : actor;
}

/** Where a person's access comes from, in words (ADR 149): never `job_role` or a default's note. */
export function accessSource(source: string, note: string | null): string {
  const from =
    source === 'job_role' ? 'comes with the job' : source === 'extra' ? 'given extra' : 'given';
  // the loader's own note ("job role default (bar_pub)") says nothing a person can use
  return note && !/^job role default/i.test(note) ? `${from} · ${note}` : from;
}

/** A person's status in words: Active, Not active. */
export function statusLabel(status: string): string {
  return status === 'active'
    ? 'Active'
    : status === 'inactive'
      ? 'Not active'
      : humanizeCode(status);
}

/** "since 17 Sep 2025", "17 Sep 2025 to 30 Sep 2025": a day in words, never 2025-09-17. */
export function sinceText(from: string, to: string | null): string {
  const d = (s: string) =>
    new Intl.DateTimeFormat('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${s.slice(0, 10)}T00:00:00Z`));
  return to ? `${d(from)} to ${d(to)}` : `since ${d(from)}`;
}
