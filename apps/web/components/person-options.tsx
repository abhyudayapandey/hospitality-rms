import type { Person } from '@/lib/tasks';

/**
 * The options of a "who" picker (ADR 110, 113): where the page knows who is on shift today, they
 * come first under "On shift today", the rest under "Not on shift today"; else one list by name.
 * The giver is never among them for a task handed on (ops.hand_on_people).
 */
export function PersonOptions({ people }: { people: Person[] }) {
  const option = (p: Person) => (
    <option key={p.user_id} value={p.user_id}>
      {p.name}
      {p.job_role ? ` (${p.job_role})` : ''}
    </option>
  );
  if (!people.some((p) => p.on_shift !== undefined)) return <>{people.map(option)}</>;
  const on = people.filter((p) => p.on_shift);
  const off = people.filter((p) => !p.on_shift);
  return (
    <>
      {on.length > 0 && <optgroup label="On shift today">{on.map(option)}</optgroup>}
      {off.length > 0 && <optgroup label="Not on shift today">{off.map(option)}</optgroup>}
    </>
  );
}

/** Who a picker starts on: someone on shift today, never whoever is first by name (ADR 113). */
export function firstPick(people: Person[]): string {
  return (people.find((p) => p.on_shift) ?? people[0])?.user_id ?? '';
}
