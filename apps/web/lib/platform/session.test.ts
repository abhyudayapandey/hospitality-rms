import { describe, expect, it } from 'vitest';
import { newSession, signSession, verifySession } from '../auth/session';
import {
  isPlatformAdmin,
  newPlatformSession,
  PLATFORM_ABSOLUTE_S,
  PLATFORM_IDLE_S,
  platformCognitoConfig,
  signPlatformSession,
  verifyPlatformSession,
} from './session';

const SECRET = 'x'.repeat(40);
const T0 = 1_800_000_000;

describe('platform sessions', () => {
  it('verify, then end after 30 minutes idle or 8 hours in all', async () => {
    const token = await signPlatformSession(newPlatformSession('admin-1', T0), SECRET);
    expect(await verifyPlatformSession(token, SECRET, T0 + 60)).toMatchObject({ ok: true });
    expect(await verifyPlatformSession(token, SECRET, T0 + PLATFORM_IDLE_S + 1)).toEqual({
      ok: false,
      reason: 'idle',
    });
    const busy = { ...newPlatformSession('admin-1', T0), seen: T0 + PLATFORM_ABSOLUTE_S };
    const busyToken = await signPlatformSession(busy, SECRET);
    expect(await verifyPlatformSession(busyToken, SECRET, T0 + PLATFORM_ABSOLUTE_S + 1)).toEqual({
      ok: false,
      reason: 'absolute',
    });
  });

  it('a customer session never passes as a platform one, nor the other way round', async () => {
    const customer = await signSession(newSession('user-1', 'cognito', T0), SECRET);
    expect(await verifyPlatformSession(customer, SECRET, T0)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    const platform = await signPlatformSession(newPlatformSession('admin-1', T0), SECRET);
    expect(await verifySession(platform, SECRET, T0)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('who becomes a platform admin', () => {
  it('only members of platform-admins with an email', () => {
    expect(isPlatformAdmin({ sub: 's', email: 'a@x.test', groups: ['platform-admins'] })).toBe(
      true,
    );
    expect(isPlatformAdmin({ sub: 's', email: 'a@x.test', groups: [] })).toBe(false);
    expect(isPlatformAdmin({ sub: 's', email: 'a@x.test', groups: ['admins'] })).toBe(false);
    expect(isPlatformAdmin({ sub: 's', email: null, groups: ['platform-admins'] })).toBe(false);
  });

  it('the platform pool has its own callback, sign-out page and scopes', () => {
    const cfg = platformCognitoConfig({
      PLATFORM_COGNITO_USER_POOL_ID: 'ap-south-1_P',
      PLATFORM_COGNITO_CLIENT_ID: 'c',
      PLATFORM_COGNITO_DOMAIN: 'https://outletops-ap-platform.auth.ap-south-1.amazoncognito.com/',
      APP_URL: 'https://ops.example.com/',
    });
    expect(cfg).toMatchObject({
      domain: 'outletops-ap-platform.auth.ap-south-1.amazoncognito.com',
      appUrl: 'https://ops.example.com',
      callbackPath: '/platform/auth/callback',
      scope: 'openid email',
    });
    expect(platformCognitoConfig({})).toBeNull();
  });
});
