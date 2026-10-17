// Migration file names (ADR 169). dbmate applies files in name order, and names start with a
// 14-digit UTC timestamp. Our files run ahead of the calendar, so a name made from today's
// clock would sort before files already applied in production and run in a different order
// there than in CI. A new file is therefore named after the newest one.

export const MIGRATION_NAME = /^(\d{14})_([a-z0-9_]+)\.sql$/;

/** The version (the 14 digits) of a migration file name; throws on any other name. */
export function versionOf(file: string): string {
  const m = MIGRATION_NAME.exec(file);
  if (!m) throw new Error(`not a migration file name: ${file}`);
  return m[1]!;
}

function parse(version: string): Date {
  const [y, mo, d, h, mi, s] = [0, 4, 6, 8, 10, 12].map((i, k) =>
    Number(version.slice(i, k === 0 ? 4 : i + 2)),
  );
  return new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!, s!));
}

function format(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    String(at.getUTCFullYear()) +
    p(at.getUTCMonth() + 1) +
    p(at.getUTCDate()) +
    p(at.getUTCHours()) +
    p(at.getUTCMinutes()) +
    p(at.getUTCSeconds())
  );
}

/**
 * The version for a new migration: one hour after the newest file (the repo's own step), or
 * the current UTC minute when that is later. Always sorts after every existing file.
 */
export function nextVersion(existing: readonly string[], now: Date): string {
  const versions = existing.filter((f) => MIGRATION_NAME.test(f)).map(versionOf).sort();
  const newest = versions.at(-1);
  const clock = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  if (!newest) return format(clock);
  const after = new Date(parse(newest).getTime() + 3_600_000);
  return format(clock > after ? clock : after);
}

/** A migration file name from a free-text name: lower case words joined by underscores. */
export function migrationFileName(existing: readonly string[], name: string, now: Date): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) throw new Error('give the migration a name, e.g. pnpm db:new add_room_notes');
  return `${nextVersion(existing, now)}_${slug}.sql`;
}

/**
 * Files out of order in a history of additions (oldest first): each step's added files
 * must sort after every file that existed before that step. The first step is the starting
 * point (a shallow clone's boundary), so its files are taken as given.
 */
export function outOfOrder(steps: readonly (readonly string[])[]): string[] {
  const bad: string[] = [];
  let newest = '';
  steps.forEach((added, i) => {
    const versions = added.filter((f) => MIGRATION_NAME.test(f)).map(versionOf);
    if (i > 0) for (const v of versions) if (v <= newest) bad.push(v);
    for (const v of versions) if (v > newest) newest = v;
  });
  return bad;
}
