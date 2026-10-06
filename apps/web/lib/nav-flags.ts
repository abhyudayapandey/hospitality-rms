// The key the bottom nav's remembered checks are kept under (ADR 055): the person, their
// home place, domains, modules and product roles. A change to any of them is a new key, so the
// checks run again on the next tap. Pure, for tests.

export function navFlagsKey(
  userId: string,
  domains: ReadonlyMap<string, string>,
  modules: ReadonlySet<string>,
  groups: ReadonlySet<string>,
  home: string | null,
): string {
  const d = [...domains].map(([k, v]) => `${k}:${v}`).sort();
  return [
    userId,
    home ?? '',
    d.join(','),
    [...modules].sort().join(','),
    [...groups].sort().join(','),
  ].join('|');
}
