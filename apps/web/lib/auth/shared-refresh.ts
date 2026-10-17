// One Cognito refresh per refresh token at a time (ADR 169): a page and its prefetches arrive
// together, and each asking Cognito on its own would spend the token several times over (and,
// with rotation on, sign the person out). The answer is kept 30 s for requests just behind.
const REFRESH_SHARE_MS = 30_000;
const refreshing = new Map<string, Promise<{ refreshToken?: string }>>();

export function sharedRefresh<T extends { refreshToken?: string }>(
  token: string,
  run: () => Promise<T>,
): Promise<T> {
  const open = refreshing.get(token) as Promise<T> | undefined;
  if (open) return open;
  const p = run();
  refreshing.set(token, p);
  const forget = () => {
    if (refreshing.get(token) === p) refreshing.delete(token);
  };
  // a failure is forgotten at once, so the next request tries again (ADR 063)
  p.then(() => setTimeout(forget, REFRESH_SHARE_MS).unref?.(), forget);
  return p;
}
