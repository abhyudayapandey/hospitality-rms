// Who covers it (ADR 061, 065): the warnings a cover may deserve and the plain-words line
// saying what moves. One rule for the onboarding loader (file 37's dry run) and Admin → Who
// does what; each counts the people itself and passes the counts in.

import { LEVELS, levelOf } from './catalogue';

/** At an outlet, a job role is done by its own people, by another role, or not at all. */
export type CoverAnswer = 'have' | 'covered_by' | 'not_done';

export interface CoverFacts {
  /** How each place and role is named: codes in the loader's report, names in Admin. */
  outlet: string;
  role: string;
  answer: CoverAnswer;
  by: string | null;
  /** Active people in the covered role at the outlet. */
  holders: number;
  /** Active people in the covering role at the outlet (with a covering role). */
  coverers: number;
  /** Duty codes of each role (`DUTY` or `DUTY@scope`), for their levels. */
  roleDuties: readonly string[];
  byDuties: readonly string[];
}

const words = (s: string) => s.replace(/_/g, ' ');
const a = (s: string) => (/^[AEIOU]/i.test(s) ? `an ${s}` : `a ${s}`);

/** What a cover may not mean to do: nobody to do it, or someone lower doing it. */
export function coverWarnings(f: CoverFacts): string[] {
  const warnings: string[] = [];
  if (f.answer === 'have') {
    if (f.holders === 0) {
      warnings.push(`nobody at ${f.outlet} is ${a(f.role)} yet, so nobody does its work`);
    }
    return warnings;
  }
  const by = f.answer === 'covered_by' ? f.by : null;
  if (f.holders > 0) {
    warnings.push(
      `${f.outlet} has ${f.holders} ${f.role}: ` +
        (by
          ? `they and every ${by} there will share its work`
          : 'its checklists stop all the same'),
    );
  }
  if (by) {
    if (f.coverers === 0) {
      warnings.push(`nobody at ${f.outlet} is ${a(by)} yet, so nobody does ${f.role}'s work`);
    }
    const [mine, theirs] = [levelOf(f.byDuties), levelOf(f.roleDuties)];
    // leading a shift or keeping a store is covered by staff every day; running a
    // department or the outlet by someone lower is worth a second look (decided 6 Oct)
    if (
      LEVELS.indexOf(theirs) >= LEVELS.indexOf('runs_department') &&
      LEVELS.indexOf(mine) < LEVELS.indexOf(theirs)
    ) {
      warnings.push(
        `${by} (${words(mine)}) covers ${f.role} (${words(theirs)}) at ${f.outlet}: ` +
          'check that is meant',
      );
    }
  }
  return warnings;
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function list(duties: readonly string[]): string {
  if (duties.length === 0) return 'its access and its tasks';
  const d = duties.map(lower);
  return d.length === 1 ? d[0]! : `${d.slice(0, -1).join(', ')} and ${d.at(-1)}`;
}

/**
 * The line saying what moves, from the covered role's duty names (`hr.duty`): what the
 * answer means once saved. `wasBy` is who covers it now, for "We have it" again.
 */
export function coverSentence(c: {
  role: string;
  answer: CoverAnswer;
  by?: string | null;
  wasBy?: string | null;
  duties: readonly string[];
}): string {
  switch (c.answer) {
    case 'covered_by':
      return `The ${c.by} does the ${c.role}'s work here: ${list(c.duties)}. Its tasks go to the ${c.by} on duty.`;
    case 'not_done':
      return (
        `Nobody does the ${c.role}'s work here: its checklists stop, and its approvals and ` +
        'alerts go to the department head, then the General Manager.'
      );
    case 'have':
      return c.wasBy
        ? `The ${c.wasBy} stops covering; the ${c.role} does this work again: ${list(c.duties)}.`
        : `The ${c.role} does this work here: ${list(c.duties)}.`;
  }
}

/** Highest level first: the outlet manager, then department heads, down to staff. */
export function byLevel<T extends { duties: readonly string[]; name: string }>(
  roles: readonly T[],
): T[] {
  return [...roles].sort(
    (a, b) =>
      LEVELS.indexOf(levelOf(b.duties)) - LEVELS.indexOf(levelOf(a.duties)) ||
      a.name.localeCompare(b.name),
  );
}
