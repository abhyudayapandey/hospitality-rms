import { createECDH } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { appLink, pushEndpointOk, pushPayload, vapidKeys } from './push';

// Web Push pieces (ADR 137): the key pair from SSM's 64 hex characters, the payload a phone
// shows, and the push services the sender will talk to (nothing else).

describe('vapidKeys', () => {
  it('derives the public key that belongs to the private key', () => {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const k = vapidKeys(ecdh.getPrivateKey('hex').padStart(64, '0'));
    expect(k.publicKey).toBe(ecdh.getPublicKey().toString('base64url'));
    expect(Buffer.from(k.privateKey, 'base64url')).toHaveLength(32);
  });
  it('refuses anything but 64 hex characters', () => {
    expect(() => vapidKeys('abc')).toThrow(/64 hex/);
  });
});

describe('pushPayload', () => {
  it('carries the title, body, link and kind; never a link off the app', () => {
    expect(
      JSON.parse(
        pushPayload({ kind: 'leave', title: 'Leave approved', body: null, link: '/leave' }),
      ),
    ).toEqual({ title: 'Leave approved', body: '', link: '/leave', tag: 'leave' });
    const off = JSON.parse(
      pushPayload({ kind: 'x', title: 't', body: 'b', link: 'https://evil.example' }),
    ) as { link: string };
    expect(off.link).toBe('/');
  });
  it('a link is a path inside the app only (ADR 166)', () => {
    for (const bad of [
      '//evil.example',
      '/\\evil',
      '\\evil',
      '/\t/evil.example',
      '/\n/evil.example',
      '/\r/evil.example',
      'javascript:alert(1)',
      'evil',
    ]) {
      expect(appLink(bad), JSON.stringify(bad)).toBe('/');
    }
    expect(appLink(null)).toBe('/');
    for (const ok of ['/', '/leave', '/stock/orders/1?tab=receive', '/%09/x']) {
      expect(appLink(ok)).toBe(ok);
    }
  });
});

describe('pushEndpointOk', () => {
  it('accepts the browsers push services only', () => {
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://web.push.apple.com/QF2x',
      'https://updates.push.services.mozilla.com/wpush/v2/x',
      'https://wns2-pn1p.notify.windows.com/w/?token=x',
    ]) {
      expect(pushEndpointOk(ok), ok).toBe(true);
    }
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://169.254.169.254/latest/meta-data',
      'https://fcm.googleapis.com.evil.example/x',
      'https://evil.example/https://fcm.googleapis.com/',
    ]) {
      expect(pushEndpointOk(bad), bad).toBe(false);
    }
  });
});
