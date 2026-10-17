import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The service worker's page timeout (ADR 169): a page that doesn't start arriving within
// 10 s shows "Can't reach", but only for GET pages. A form post (an upload) can take longer
// on mobile data and is never cut short, and the "Can't reach" screen never posts it again.

const source = readFileSync(join(import.meta.dirname, '..', 'public', 'sw.js'), 'utf8');

type Handler = (e: { request: object; respondWith: (p: Promise<Response>) => void }) => void;

function load(fetch: (req: object) => Promise<Response>) {
  const handlers: Record<string, Handler> = {};
  runInNewContext(source, {
    self: {
      addEventListener: (t: string, fn: Handler) => (handlers[t] = fn),
      location: { origin: 'https://app.test' },
      skipWaiting: () => undefined,
    },
    fetch,
    Response,
    URL,
    Promise,
    setTimeout,
    clearTimeout,
  });
  return (method: string, path: string) => {
    let out: Promise<Response> | undefined;
    handlers.fetch!({
      request: { mode: 'navigate', method, url: `https://app.test${path}` },
      respondWith: (p) => {
        out = p;
      },
    });
    return out!;
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the service worker', () => {
  it('a slow GET page shows Can’t reach after 10 s', async () => {
    const nav = load(() => new Promise(() => undefined));
    const page = nav('GET', '/stock');
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await page).status).toBe(503);
  });

  it('a slow form post is waited for, not cut short', async () => {
    let arrive: (r: Response) => void = () => undefined;
    const nav = load(() => new Promise((r) => (arrive = r)));
    const page = nav('POST', '/platform/customers/x/import/upload');
    await vi.advanceTimersByTimeAsync(30_000);
    arrive(new Response('done', { status: 303 }));
    expect((await page).status).toBe(303);
  });

  it('Can’t reach tries again with a GET, waiting longer each time', async () => {
    const nav = load(() => Promise.reject(new TypeError('Failed to fetch')));
    const html = await (await nav('POST', '/x')).text();
    expect(html).not.toContain('location.reload()');
    expect(html).toContain('location.replace(location.href)');
    expect(html).toMatch(/sessionStorage/);
  });
});
