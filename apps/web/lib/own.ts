/**
 * A record's own entry for a key from the address bar, never one it inherits: `?reason=constructor`
 * or `/export/toString` would otherwise find Object's own functions (ADR 169).
 */
export function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
