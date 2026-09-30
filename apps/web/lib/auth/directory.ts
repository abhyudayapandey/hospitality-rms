import {
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';

// The customer pool's logins, as the admin screens change them (ADR 011). Every call is
// made only after the matching core.* function has checked scope and rank and written the
// audit row; Cognito is the second step, and each operation can be retried safely.
// Without Cognito configured (dev, e2e) the no-op directory stands in.

export interface NewLogin {
  username: string;
  loginType: 'username' | 'email';
  email?: string | null;
  /** Username logins: set as a temporary password, changed at the next sign-in. */
  temporaryPassword?: string;
  /**
   * Send Cognito's invitation email (a new customer's first owner, ADR 012): they set their
   * own password. Otherwise no message is sent.
   */
  invite?: boolean;
}

export interface LoginDirectory {
  /** Creates the login (or finds the existing one) and returns its sub. */
  create(login: NewLogin): Promise<{ sub: string }>;
  setTemporaryPassword(username: string, password: string): Promise<void>;
  /** Test customers' Test<Role>!12 passwords only (ADR 013): kept at the next sign-in. */
  setPermanentPassword(username: string, password: string): Promise<void>;
  disable(username: string): Promise<void>;
  enable(username: string): Promise<void>;
  /** Revokes every refresh token: signed out everywhere at the next token refresh. */
  signOutEverywhere(username: string): Promise<void>;
  setEmail(username: string, email: string): Promise<void>;
}

/** The subset of the SDK client the directory uses (tests pass a fake). */
export interface CognitoSender {
  send(command: object): Promise<unknown>;
}

export class CognitoDirectory implements LoginDirectory {
  constructor(
    private readonly client: CognitoSender,
    private readonly userPoolId: string,
  ) {}

  async create(login: NewLogin): Promise<{ sub: string }> {
    const attributes = [
      ...(login.email
        ? [
            { Name: 'email', Value: login.email },
            { Name: 'email_verified', Value: 'true' },
          ]
        : []),
    ];
    try {
      const r = (await this.client.send(
        new AdminCreateUserCommand({
          UserPoolId: this.userPoolId,
          Username: login.username,
          UserAttributes: attributes,
          // username logins get the password from the admin; email logins sign in with a
          // one-time code and need no invitation message from Cognito
          ...(login.temporaryPassword ? { TemporaryPassword: login.temporaryPassword } : {}),
          ...(login.invite
            ? { DesiredDeliveryMediums: ['EMAIL' as const] }
            : { MessageAction: 'SUPPRESS' as const }),
        }),
      )) as { User?: { Attributes?: { Name?: string; Value?: string }[] } };
      const sub = r.User?.Attributes?.find((a) => a.Name === 'sub')?.Value;
      if (sub) return { sub };
    } catch (err) {
      if (!(err instanceof UsernameExistsException)) throw err;
      if (login.temporaryPassword) {
        await this.setTemporaryPassword(login.username, login.temporaryPassword);
      }
    }
    return { sub: await this.sub(login.username) };
  }

  private async sub(username: string): Promise<string> {
    const r = (await this.client.send(
      new AdminGetUserCommand({ UserPoolId: this.userPoolId, Username: username }),
    )) as { UserAttributes?: { Name?: string; Value?: string }[] };
    const sub = r.UserAttributes?.find((a) => a.Name === 'sub')?.Value;
    if (!sub) throw new Error(`login ${username} has no sub`);
    return sub;
  }

  async setTemporaryPassword(username: string, password: string): Promise<void> {
    await this.client.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: this.userPoolId,
        Username: username,
        Password: password,
        Permanent: false,
      }),
    );
  }

  async setPermanentPassword(username: string, password: string): Promise<void> {
    await this.client.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: this.userPoolId,
        Username: username,
        Password: password,
        Permanent: true,
      }),
    );
  }

  async disable(username: string): Promise<void> {
    await this.client.send(
      new AdminDisableUserCommand({ UserPoolId: this.userPoolId, Username: username }),
    );
  }

  async enable(username: string): Promise<void> {
    await this.client.send(
      new AdminEnableUserCommand({ UserPoolId: this.userPoolId, Username: username }),
    );
  }

  async signOutEverywhere(username: string): Promise<void> {
    await this.client.send(
      new AdminUserGlobalSignOutCommand({ UserPoolId: this.userPoolId, Username: username }),
    );
  }

  async setEmail(username: string, email: string): Promise<void> {
    await this.client.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: this.userPoolId,
        Username: username,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
        ],
      }),
    );
  }
}

/** Dev and e2e: no Cognito. Logins get a stable fake sub; everything else is a no-op. */
export class NoopDirectory implements LoginDirectory {
  create(login: NewLogin): Promise<{ sub: string }> {
    return Promise.resolve({ sub: `local:${login.username}` });
  }
  setTemporaryPassword(): Promise<void> {
    return Promise.resolve();
  }
  setPermanentPassword(): Promise<void> {
    return Promise.resolve();
  }
  disable(): Promise<void> {
    return Promise.resolve();
  }
  enable(): Promise<void> {
    return Promise.resolve();
  }
  signOutEverywhere(): Promise<void> {
    return Promise.resolve();
  }
  setEmail(): Promise<void> {
    return Promise.resolve();
  }
}

let cached: LoginDirectory | undefined;

/** The customer pool (region from the pool id, credentials from the instance role). */
export function loginDirectory(
  env: Record<string, string | undefined> = process.env,
): LoginDirectory {
  if (cached) return cached;
  const poolId = env.COGNITO_USER_POOL_ID;
  cached = poolId
    ? new CognitoDirectory(
        new CognitoIdentityProviderClient({ region: poolId.split('_')[0] ?? 'ap-south-1' }),
        poolId,
      )
    : new NoopDirectory();
  return cached;
}
