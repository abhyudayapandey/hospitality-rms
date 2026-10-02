import { NotAuthorizedException } from '@aws-sdk/client-cognito-identity-provider';
import { describe, expect, it } from 'vitest';
import { CognitoDirectory, NoopDirectory, type CognitoSender } from './directory';
import { passwordProblems } from './passwords';
import { issuedBeforeSignOut } from './session';

// The profile's own login actions (Prompt 11a, ADR 018).

describe('the customer pool password policy', () => {
  it('at least 10 characters, a digit and a lower-case letter', () => {
    expect(passwordProblems('kitchen2026')).toEqual([]);
    expect(passwordProblems('Kitchen 2026 is hot')).toEqual([]);
    expect(passwordProblems('short1')).toEqual(['at least 10 characters']);
    expect(passwordProblems('kitchenkitchen')).toEqual(['a digit']);
    expect(passwordProblems('KITCHEN2026')).toEqual(['a lower-case letter']);
    expect(passwordProblems('')).toEqual([
      'at least 10 characters',
      'a digit',
      'a lower-case letter',
    ]);
  });
});

describe('changing your own password in Cognito', () => {
  function fake(responses: (() => unknown)[]) {
    const calls: { name: string; input: unknown }[] = [];
    const sender: CognitoSender = {
      send(command) {
        const c = command as { constructor: { name: string }; input: unknown };
        calls.push({ name: c.constructor.name, input: c.input });
        const next = responses.shift();
        return Promise.resolve().then(() => (next ? next() : {}));
      },
    };
    return { sender, calls };
  }

  it('checks the current password with a sign-in, then changes it with that session', async () => {
    const { sender, calls } = fake([
      () => ({ AuthenticationResult: { AccessToken: 'at-1' } }),
      () => ({}),
    ]);
    const d = new CognitoDirectory(sender, 'ap-south-1_pool', 'client-1');
    expect(await d.changeOwnPassword('acme.ravi.k', 'old-pass-1', 'new-pass-22')).toBe('ok');
    expect(calls).toEqual([
      {
        name: 'InitiateAuthCommand',
        input: {
          ClientId: 'client-1',
          AuthFlow: 'USER_PASSWORD_AUTH',
          AuthParameters: { USERNAME: 'acme.ravi.k', PASSWORD: 'old-pass-1' },
        },
      },
      {
        name: 'ChangePasswordCommand',
        input: {
          AccessToken: 'at-1',
          PreviousPassword: 'old-pass-1',
          ProposedPassword: 'new-pass-22',
        },
      },
    ]);
  });

  it('a wrong current password is wrong_password, and nothing is changed', async () => {
    const { sender, calls } = fake([
      () => {
        throw new NotAuthorizedException({ message: 'Incorrect', $metadata: {} });
      },
    ]);
    const d = new CognitoDirectory(sender, 'ap-south-1_pool', 'client-1');
    expect(await d.changeOwnPassword('acme.ravi.k', 'nope', 'new-pass-22')).toBe('wrong_password');
    expect(calls.map((c) => c.name)).toEqual(['InitiateAuthCommand']);
  });

  it('a sign-in that asks for more (a temporary password) changes nothing', async () => {
    const { sender, calls } = fake([() => ({ ChallengeName: 'NEW_PASSWORD_REQUIRED' })]);
    const d = new CognitoDirectory(sender, 'ap-south-1_pool', 'client-1');
    expect(await d.changeOwnPassword('acme.ravi.k', 'tmp', 'new-pass-22')).toBe('wrong_password');
    expect(calls).toHaveLength(1);
  });

  it('dev and e2e (no Cognito) accept any change', async () => {
    expect(await new NoopDirectory().changeOwnPassword()).toBe('ok');
  });
});

describe('sign out of all devices', () => {
  it('refuses a session issued before the sign-out; a later one is fine', () => {
    const at = new Date('2026-10-05T10:00:00.400Z');
    const s = Math.floor(at.getTime() / 1000);
    expect(issuedBeforeSignOut(s - 60, at)).toBe(true);
    expect(issuedBeforeSignOut(s, at)).toBe(false); // the same second: signed in again
    expect(issuedBeforeSignOut(s + 5, at)).toBe(false);
    expect(issuedBeforeSignOut(s - 60, null)).toBe(false);
  });
});
