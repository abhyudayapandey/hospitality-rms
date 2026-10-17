// An app left open across a deploy runs the old build, whose server actions are gone. Once the
// version check knows (ADR 055), saved offline items wait for the reload rather than being sent
// by code the server no longer has (ADR 169).

let stale = false;

export function markStale(): void {
  stale = true;
}

export function isStale(): boolean {
  return stale;
}
