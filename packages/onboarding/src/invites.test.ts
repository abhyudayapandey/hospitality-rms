import { UsernameExistsException } from '@aws-sdk/client-cognito-identity-provider';
import { describe, expect, it } from 'vitest';
import { CognitoInviteSender, type CognitoSender } from './invites';

// The worker's invitations (ADR 013): an email login created without a password, so the
// pool's invitation (which explains the email code) carries none.

function fake(responses: (() => unknown)[]) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const sender: CognitoSender = {
    send(command) {
      const c = command as { constructor: { name: string }; input: Record<string, unknown> };
      calls.push({ name: c.constructor.name, input: c.input });
      const next = responses.shift();
      return Promise.resolve().then(() => (next ? next() : {}));
    },
  };
  return { sender, calls };
}

describe('CognitoInviteSender', () => {
  it('creates the email login without a password and sends the invitation', async () => {
    const { sender, calls } = fake([
      () => ({ User: { Attributes: [{ Name: 'sub', Value: 'sub-1' }] } }),
    ]);
    const r = await new CognitoInviteSender(sender, 'ap-south-1_pool').invite({
      username: 'acme.asha',
      email: 'asha@acme.example',
    });
    expect(r).toEqual({ sub: 'sub-1', sent: true });
    expect(calls).toEqual([
      {
        name: 'AdminCreateUserCommand',
        input: {
          UserPoolId: 'ap-south-1_pool',
          Username: 'acme.asha',
          UserAttributes: [
            { Name: 'email', Value: 'asha@acme.example' },
            { Name: 'email_verified', Value: 'true' },
          ],
          DesiredDeliveryMediums: ['EMAIL'],
        },
      },
    ]);
  });

  it('an existing login is linked, not invited again', async () => {
    const { sender, calls } = fake([
      () => {
        throw new UsernameExistsException({ message: 'exists', $metadata: {} });
      },
      () => ({ UserAttributes: [{ Name: 'sub', Value: 'sub-2' }] }),
    ]);
    const r = await new CognitoInviteSender(sender, 'ap-south-1_pool').invite({
      username: 'acme.asha',
      email: 'asha@acme.example',
    });
    expect(r).toEqual({ sub: 'sub-2', sent: false });
    expect(calls.map((c) => c.name)).toEqual(['AdminCreateUserCommand', 'AdminGetUserCommand']);
  });

  it('refuses a person without an email', async () => {
    const { sender, calls } = fake([]);
    await expect(
      new CognitoInviteSender(sender, 'ap-south-1_pool').invite({
        username: 'acme.ravi',
        email: '',
      }),
    ).rejects.toThrow('no email');
    expect(calls).toEqual([]);
  });
});
