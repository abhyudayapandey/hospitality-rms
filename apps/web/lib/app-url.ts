// Every redirect we build points at APP_URL, never at the incoming request's URL. Behind
// Caddy the app listens on 127.0.0.1:3000, so request.url names that address, not the
// public one (the B1 platform sign-in bug). Relative redirects from next/navigation are
// fine: the browser resolves them against the address it is on.

export function appUrl(path: string, env: Record<string, string | undefined> = process.env): URL {
  const base = env.APP_URL;
  if (!base) throw new Error('APP_URL is not set');
  return new URL(path, base.replace(/\/?$/, '/'));
}
