// CSRF protection that does not rely on Next.js alone (ADR 011): every admin server action
// and route handler calls requireSameOrigin(). The request's Origin must be APP_URL's
// origin, and Sec-Fetch-Site, when the browser sends it, must be same-origin.

export interface HeaderSource {
  get(name: string): string | null;
}

export function isSameOrigin(headers: HeaderSource, appUrl: string): boolean {
  const expected = new URL(appUrl).origin;
  const origin = headers.get('origin');
  if (!origin || origin === 'null') return false;
  let actual: string;
  try {
    actual = new URL(origin).origin;
  } catch {
    return false;
  }
  if (actual !== expected) return false;
  const site = headers.get('sec-fetch-site');
  return site === null || site === 'same-origin';
}

export class CrossOriginError extends Error {
  readonly code = 'CROSS_ORIGIN';
  constructor() {
    super('CROSS_ORIGIN');
  }
}

/** Throws CrossOriginError unless the current request comes from the app itself. */
export async function requireSameOrigin(): Promise<void> {
  const { headers } = await import('next/headers');
  const appUrl = process.env.APP_URL;
  if (!appUrl) throw new Error('APP_URL is not set');
  if (!isSameOrigin(await headers(), appUrl)) throw new CrossOriginError();
}
