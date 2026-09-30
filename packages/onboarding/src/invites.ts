import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';

// Email logins for a customer's people (ADR 013): Cognito's invitation email, sent by the
// platform worker within the pool's daily allowance. A login that already exists is linked,
// not invited again. Without Cognito (dev, e2e) nothing is sent and the login gets a
// stable local sub, as the web app's no-op directory does.

export interface Invitee {
  username: string;
  email: string;
}

export interface InviteSender {
  /** Creates the login and sends the invitation; returns the login's sub. */
  invite(person: Invitee): Promise<{ sub: string; sent: boolean }>;
}

/** The subset of the SDK client the sender uses (tests pass a fake). */
export interface CognitoSender {
  send(command: object): Promise<unknown>;
}

type Attributes = { Name?: string; Value?: string }[] | undefined;
const subOf = (a: Attributes) => a?.find((x) => x.Name === 'sub')?.Value;

export class CognitoInviteSender implements InviteSender {
  constructor(
    private readonly client: CognitoSender,
    private readonly userPoolId: string,
  ) {}

  async invite(person: Invitee): Promise<{ sub: string; sent: boolean }> {
    try {
      const r = (await this.client.send(
        new AdminCreateUserCommand({
          UserPoolId: this.userPoolId,
          Username: person.username,
          UserAttributes: [
            { Name: 'email', Value: person.email },
            { Name: 'email_verified', Value: 'true' },
          ],
          DesiredDeliveryMediums: ['EMAIL'],
        }),
      )) as { User?: { Attributes?: Attributes } };
      const sub = subOf(r.User?.Attributes);
      if (sub) return { sub, sent: true };
    } catch (err) {
      if (!(err instanceof UsernameExistsException)) throw err;
    }
    const got = (await this.client.send(
      new AdminGetUserCommand({ UserPoolId: this.userPoolId, Username: person.username }),
    )) as { UserAttributes?: Attributes };
    const sub = subOf(got.UserAttributes);
    if (!sub) throw new Error(`login ${person.username} has no sub`);
    return { sub, sent: false };
  }
}

export class NoopInviteSender implements InviteSender {
  invite(person: Invitee): Promise<{ sub: string; sent: boolean }> {
    return Promise.resolve({ sub: `local:${person.username}`, sent: true });
  }
}

/** The customer pool (COGNITO_USER_POOL_ID, instance role credentials), else no-op. */
export function inviteSender(env: Record<string, string | undefined> = process.env): InviteSender {
  const poolId = env.COGNITO_USER_POOL_ID;
  return poolId
    ? new CognitoInviteSender(
        new CognitoIdentityProviderClient({ region: poolId.split('_')[0] ?? 'ap-south-1' }),
        poolId,
      )
    : new NoopInviteSender();
}
