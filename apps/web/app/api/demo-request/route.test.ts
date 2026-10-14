import { beforeEach, describe, expect, it, vi } from 'vitest';

// The website's demo form (ADR 141): the one route with no session. Origin, rate limit, the
// bots' trap and the fields are checked here before anything reaches the database (which
// checks again; demo-requests.db.test.ts).

const SITE = 'https://heysenior.app';
const state = {
  within: true,
  stored: [] as unknown[],
  keys: [] as string[],
  fail: null as Error | null,
};

vi.mock('server-only', () => ({}));
vi.mock('@/lib/security/rate-limit', () => ({
  LIMITS: { demoRequest: { limit: 5, windowS: 3600 } },
  clientAddress: (h: Headers) => h.get('x-forwarded-for') ?? 'unknown',
  withinLimit: (key: string) => {
    state.keys.push(key);
    return Promise.resolve(state.within);
  },
}));
vi.mock('@/lib/db', () => ({
  addDemoRequest: (r: unknown) => {
    if (state.fail) return Promise.reject(state.fail);
    state.stored.push(r);
    return Promise.resolve('id-1');
  },
}));

const { POST } = await import('./route');

const form = {
  name: 'Asha Rao',
  phone: '+91 98200 12345',
  email: '',
  business: 'Blue Bean Café',
  outletKind: 'Restaurant',
  outlets: '1',
  website: '',
};

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request('http://127.0.0.1:3000/api/demo-request', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: SITE,
        'sec-fetch-site': 'same-origin',
        'x-forwarded-for': '203.0.113.7',
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

beforeEach(() => {
  state.within = true;
  state.stored = [];
  state.fail = null;
  state.keys = [];
  vi.stubEnv('SITE_URL', SITE);
});

describe('POST /api/demo-request', () => {
  it('stores a request from the website, in the codes the database keeps', async () => {
    const res = await post(form);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(state.stored).toEqual([{ ...form, outletKind: 'restaurant', outlets: '1' }]);
    expect(state.keys).toEqual(['demo:203.0.113.7']);
  });

  it.each([
    ['from the app', { origin: 'https://my.heysenior.app' }],
    ['from another site', { origin: 'https://evil.example' }],
    ['with no origin', { origin: '' }],
    ['sent cross-site', { 'sec-fetch-site': 'cross-site' }],
  ])('refuses a request %s', async (_, headers) => {
    const res = await post(form, headers);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'CROSS_ORIGIN' });
    expect(state.stored).toEqual([]);
  });

  it('refuses everything when SITE_URL is not set', async () => {
    vi.stubEnv('SITE_URL', '');
    expect((await post(form)).status).toBe(403);
  });

  it('refuses an address over its limit', async () => {
    state.within = false;
    const res = await post(form);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ code: 'RATE_LIMITED' });
    expect(state.stored).toEqual([]);
  });

  it('thanks a bot that filled the trap, and stores nothing', async () => {
    const res = await post({ ...form, website: 'https://spam.example' });
    expect(res.status).toBe(200);
    expect(state.stored).toEqual([]);
  });

  it.each([
    ['not JSON', '{name'],
    ['no phone', { ...form, phone: '' }],
    ['an unknown kind of outlet', { ...form, outletKind: 'Spa' }],
  ])('refuses %s', async (_, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'INVALID_DEMO_REQUEST' });
  });

  it("passes on the database's flood guard, and never shows a raw error", async () => {
    state.fail = new Error('RATE_LIMITED');
    expect((await post(form)).status).toBe(429);
    state.fail = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    const res = await post(form);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ code: 'UNEXPECTED' });
  });
});
