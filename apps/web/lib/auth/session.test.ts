import { describe, expect, it } from 'vitest';
import {
  ABSOLUTE_TIMEOUT_S,
  IDLE_TIMEOUT_S,
  newSession,
  pkceChallenge,
  sessionMaxAge,
  signSession,
  verifySession,
} from './session';

const SECRET = 'test-secret-0123456789-0123456789-abcdef';
const T0 = 1_800_000_000;

describe('session cookie', () => {
  it('round-trips a signed session', async () => {
    const token = await signSession(newSession('u1', 'dev', T0), SECRET);
    const v = await verifySession(token, SECRET, T0 + 10);
    expect(v).toEqual({
      ok: true,
      payload: { v: 1, uid: 'u1', src: 'dev', iat: T0, seen: T0, ref: T0 },
    });
  });

  it('rejects a tampered payload, a wrong secret and garbage', async () => {
    const token = await signSession(newSession('u1', 'dev', T0), SECRET);
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...newSession('admin', 'dev', T0) })).toString(
      'base64url',
    );
    expect(await verifySession(`${forged}.${sig}`, SECRET, T0)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(await verifySession(`${body}.${sig}x`, SECRET, T0)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(await verifySession(token, `${SECRET}-other`, T0)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    for (const junk of [undefined, '', 'a', 'a.b', 'a.b.c', '!!!.???']) {
      expect(await verifySession(junk, SECRET, T0)).toEqual({ ok: false, reason: 'invalid' });
    }
  });

  it('expires after 12 h idle', async () => {
    const token = await signSession(newSession('u1', 'dev', T0), SECRET);
    expect((await verifySession(token, SECRET, T0 + IDLE_TIMEOUT_S)).ok).toBe(true);
    expect(await verifySession(token, SECRET, T0 + IDLE_TIMEOUT_S + 1)).toEqual({
      ok: false,
      reason: 'idle',
    });
  });

  it('expires 30 days after sign-in even when active', async () => {
    const active = { ...newSession('u1', 'dev', T0), seen: T0 + ABSOLUTE_TIMEOUT_S };
    const token = await signSession(active, SECRET);
    expect((await verifySession(token, SECRET, T0 + ABSOLUTE_TIMEOUT_S)).ok).toBe(true);
    expect(await verifySession(token, SECRET, T0 + ABSOLUTE_TIMEOUT_S + 1)).toEqual({
      ok: false,
      reason: 'absolute',
    });
    expect(sessionMaxAge(active, T0 + 100)).toBe(ABSOLUTE_TIMEOUT_S - 100);
  });

  it('refuses a short secret', async () => {
    await expect(signSession(newSession('u1', 'dev'), 'short')).rejects.toThrow(/32/);
  });

  it('computes the RFC 7636 PKCE challenge', async () => {
    // Appendix B test vector
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});
