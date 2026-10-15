// Who may renew a licence or answer for a regular job (ADR 151): the roles that run something
// there (the outlet, a department), else, where none is listed, every role. Anyone may do a job.

export function answering<R extends { answers?: boolean }>(roles: readonly R[]): R[] {
  const running = roles.filter((r) => r.answers);
  return running.length > 0 ? running : [...roles];
}
