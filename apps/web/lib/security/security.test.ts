import { UsernameExistsException } from '@aws-sdk/client-cognito-identity-provider';
import { describe, expect, it } from 'vitest';
import { CognitoDirectory, type CognitoSender } from '../auth/directory';
import { generateTemporaryPassword } from '../auth/passwords';
import { isSameOrigin } from './same-origin';

const headers = (h: Record<string, string>) => ({
  get: (name: string) => h[name.toLowerCase()] ?? null,
});

describe('same-origin check (CSRF)', () => {
  const APP = 'https://ops.example.com';
  it('accepts the app itself', () => {
    expect(isSameOrigin(headers({ origin: APP }), APP)).toBe(true);
    expect(isSameOrigin(headers({ origin: APP, 'sec-fetch-site': 'same-origin' }), APP)).toBe(true);
    expect(isSameOrigin(headers({ origin: APP }), `${APP}/`)).toBe(true);
  });
  it('refuses another site, a missing or null Origin, and cross-site fetch metadata', () => {
    expect(isSameOrigin(headers({ origin: 'https://evil.example' }), APP)).toBe(false);
    expect(isSameOrigin(headers({ origin: 'https://ops.example.com.evil.example' }), APP)).toBe(
      false,
    );
    expect(isSameOrigin(headers({ origin: 'http://ops.example.com' }), APP)).toBe(false);
    expect(isSameOrigin(headers({}), APP)).toBe(false);
    expect(isSameOrigin(headers({ origin: 'null' }), APP)).toBe(false);
    expect(isSameOrigin(headers({ origin: APP, 'sec-fetch-site': 'cross-site' }), APP)).toBe(false);
    expect(isSameOrigin(headers({ origin: APP, 'sec-fetch-site': 'same-site' }), APP)).toBe(false);
  });
});

describe('temporary passwords', () => {
  it('meet the pool policy: length, a digit, a lower- and an upper-case letter', () => {
    for (let i = 0; i < 200; i++) {
      const p = generateTemporaryPassword();
      expect(p).toHaveLength(14);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).not.toMatch(/[01ilo]/i);
    }
  });
  it('are not repeated and refuse short lengths', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateTemporaryPassword()));
    expect(seen.size).toBe(500);
    expect(() => generateTemporaryPassword(8)).toThrow();
  });
});

describe('Cognito directory', () => {
  function fake(
    responses: ((cmd: { constructor: { name: string }; input: unknown }) => unknown)[],
  ) {
    const calls: { name: string; input: unknown }[] = [];
    const sender: CognitoSender = {
      send(command) {
        const c = command as { constructor: { name: string }; input: unknown };
        calls.push({ name: c.constructor.name, input: c.input });
        const next = responses.shift();
        // a throwing response becomes a rejected promise, as the SDK reports errors
        return Promise.resolve().then(() => (next ? next(c) : {}));
      },
    };
    return { sender, calls };
  }

  it('creates a username login with a temporary password and no Cognito message', async () => {
    const { sender, calls } = fake([
      () => ({ User: { Attributes: [{ Name: 'sub', Value: 'sub-1' }] } }),
    ]);
    const d = new CognitoDirectory(sender, 'ap-south-1_pool');
    expect(
      await d.create({ username: 'acme.ravi.k', loginType: 'username', temporaryPassword: 'Tmp' }),
    ).toEqual({ sub: 'sub-1' });
    expect(calls).toEqual([
      {
        name: 'AdminCreateUserCommand',
        input: {
          UserPoolId: 'ap-south-1_pool',
          Username: 'acme.ravi.k',
          UserAttributes: [],
          TemporaryPassword: 'Tmp',
          MessageAction: 'SUPPRESS',
        },
      },
    ]);
  });

  it('an existing login is found, not duplicated (safe to retry)', async () => {
    const { sender, calls } = fake([
      () => {
        throw new UsernameExistsException({ message: 'exists', $metadata: {} });
      },
      () => ({}),
      () => ({ UserAttributes: [{ Name: 'sub', Value: 'sub-2' }] }),
    ]);
    const d = new CognitoDirectory(sender, 'ap-south-1_pool');
    expect(
      await d.create({ username: 'acme.ravi.k', loginType: 'username', temporaryPassword: 'Tmp' }),
    ).toEqual({ sub: 'sub-2' });
    expect(calls.map((c) => c.name)).toEqual([
      'AdminCreateUserCommand',
      'AdminSetUserPasswordCommand',
      'AdminGetUserCommand',
    ]);
  });

  it('disables and signs out with exactly those calls', async () => {
    const { sender, calls } = fake([]);
    const d = new CognitoDirectory(sender, 'ap-south-1_pool');
    await d.disable('acme.ravi.k');
    await d.signOutEverywhere('acme.ravi.k');
    expect(calls.map((c) => c.name)).toEqual([
      'AdminDisableUserCommand',
      'AdminUserGlobalSignOutCommand',
    ]);
  });
});
