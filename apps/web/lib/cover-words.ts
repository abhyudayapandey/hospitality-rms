import type { CoverAnswer } from '@outlet-ops/domain';

// Admin → Who does what (ADR 065), in the words people see. Pure, for the server pages and
// the form in the browser.

const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

/** The answer as Admin words it; a step or status is never shown as its code. */
export function answerWords(r: {
  answer: CoverAnswer;
  covered_by_name: string | null;
  people: number;
}): string {
  if (r.answer === 'covered_by') return `Someone else does it: ${r.covered_by_name}`;
  if (r.answer === 'not_done') return "We don't do this";
  return r.people === 0
    ? 'We have it · nobody here yet'
    : `We have it · ${n(r.people, 'person', 'people')}`;
}

export interface CoverOutcome {
  changed: boolean;
  pending?: number;
  people?: { name: string; waiting: number }[];
  tasks_returned?: number;
  tasks_given?: number;
  tasks_open?: number;
}

/** What saving does, line by line, for the preview. */
export function outcomeLines(
  o: CoverOutcome,
  c: { answer: CoverAnswer; role: string; by: string | null },
): string[] {
  if (!o.changed) return ["That's how it is now: nothing changes."];
  const lines: string[] = [];
  const now = (o.people ?? []).filter((p) => p.waiting === 0).map((p) => p.name);
  const waiting = (o.people ?? []).filter((p) => p.waiting > 0);
  if (now.length) lines.push(`Their access changes at once: ${now.join(', ')}.`);
  for (const p of waiting) {
    lines.push(
      `${p.name}: ${n(p.waiting, 'access change waits', 'access changes wait')} for approval.`,
    );
  }
  if (!now.length && !waiting.length) lines.push("Nobody's access changes.");
  if (o.tasks_returned) {
    lines.push(
      c.answer === 'covered_by'
        ? `${n(o.tasks_returned, 'unstarted task moves', 'unstarted tasks move')} to the ${c.by}.`
        : `${n(o.tasks_returned, 'unstarted task goes', 'unstarted tasks go')} back to the ${c.role}'s To do list.`,
    );
  }
  if (o.tasks_given) {
    lines.push(
      `${n(o.tasks_given, 'task due now goes', 'tasks due now go')} to the ${c.by} on duty.`,
    );
  }
  if (c.answer === 'not_done' && o.tasks_open) {
    lines.push(
      `${n(o.tasks_open, 'open task stays', 'open tasks stay')} unassigned; nothing is cancelled.`,
    );
  }
  return lines;
}

/** What Save says: never that the cover works now while access waits for approval. */
export function savedMessage(o: CoverOutcome): string {
  if (!o.changed) return "Nothing to change: that's how it is now.";
  const pending = o.pending ?? 0;
  if (pending > 0) {
    return `Saved. ${n(pending, 'access change is', 'access changes are')} waiting for approval, so the cover isn't fully working yet.`;
  }
  const people = (o.people ?? []).length;
  return people ? `Saved. Access changed at once for ${n(people, 'person', 'people')}.` : 'Saved.';
}
