import {
  NotAuthorizedException,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { describe, expect, it } from 'vitest';
import { CognitoDirectory, type CognitoSender } from './directory';

// Deactivating or reactivating someone in Admin (ADR 011): the database step comes first, then
// Cognito. A person whose login was never created has nothing to disable, so that is done, not
// "Something went wrong"; any other Cognito error still fails.

function sender(fail: () => Error): CognitoSender & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    send(command) {
      calls.push((command as { constructor: { name: string } }).constructor.name);
      return Promise.reject(fail());
    },
  };
}

const notFound = () =>
  new UserNotFoundException({ message: 'User does not exist.', $metadata: {} });

describe('a person with no login yet', () => {
  it('disable, enable and sign out everywhere do nothing and succeed', async () => {
    const s = sender(notFound);
    const d = new CognitoDirectory(s, 'ap-south-1_pool');
    await expect(d.disable('test.solo.stock-verifier')).resolves.toBeUndefined();
    await expect(d.signOutEverywhere('test.solo.stock-verifier')).resolves.toBeUndefined();
    await expect(d.enable('test.solo.stock-verifier')).resolves.toBeUndefined();
    expect(s.calls).toEqual([
      'AdminDisableUserCommand',
      'AdminUserGlobalSignOutCommand',
      'AdminEnableUserCommand',
    ]);
  });

  it('any other Cognito error still fails', async () => {
    const d = new CognitoDirectory(
      sender(() => new NotAuthorizedException({ message: 'denied', $metadata: {} })),
      'ap-south-1_pool',
    );
    await expect(d.disable('acme.ravi.k')).rejects.toBeInstanceOf(NotAuthorizedException);
  });
});
