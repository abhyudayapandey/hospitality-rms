import {
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  AdminUserGlobalSignOutCommand,
  ChangePasswordCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  NotAuthorizedException,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';

// The customer pool's logins, as the admin screens change them (ADR 011). Every call is
// made only after the matching core.* function has checked scope and rank and written the
// audit row; Cognito is the second step, and each operation can be retried safely.
// Without Cognito configured (dev, e2e) the no-op directory stands in.
//
// changeOwnPassword is the one call made as the person, not as an admin (ADR 018): a
// USER_PASSWORD_AUTH sign-in with their current password (the Web client allows it), then
// ChangePassword with that session's access token. Cognito applies the pool's policy.

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
  /** The person's own change: their current password, then the new one. */
  changeOwnPassword(username: string, current: string, next: string): Promise<OwnPasswordResult>;
}

export type OwnPasswordResult = 'ok' | 'wrong_password';

/** The subset of the SDK client the directory uses (tests pass a fake). */
export interface CognitoSender {
  send(command: object): Promise<unknown>;
}

export class CognitoDirectory implements LoginDirectory {
  constructor(
    private readonly client: CognitoSender,
    private readonly userPoolId: string,
    private readonly clientId?: string,
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
    // Only an email login without a password is ever invited (ADR 013): the pool's
    // invitation explains the email code. Username logins never get an email.
    const invite =
      login.invite === true &&
      login.loginType === 'email' &&
      !!login.email &&
      !login.temporaryPassword;
    try {
      const r = (await this.client.send(
        new AdminCreateUserCommand({
          UserPoolId: this.userPoolId,
          Username: login.username,
          UserAttributes: attributes,
          // username logins get the password from the admin; email logins sign in with a
          // one-time code and need no invitation message from Cognito
          ...(login.temporaryPassword ? { TemporaryPassword: login.temporaryPassword } : {}),
          ...(invite
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

  async changeOwnPassword(
    username: string,
    current: string,
    next: string,
  ): Promise<OwnPasswordResult> {
    if (!this.clientId) throw new Error('COGNITO_CLIENT_ID is not set');
    let auth: { AuthenticationResult?: { AccessToken?: string } };
    try {
      auth = (await this.client.send(
        new InitiateAuthCommand({
          ClientId: this.clientId,
          AuthFlow: 'USER_PASSWORD_AUTH',
          AuthParameters: { USERNAME: username, PASSWORD: current },
        }),
      )) as typeof auth;
    } catch (err) {
      if (err instanceof NotAuthorizedException) return 'wrong_password';
      throw err;
    }
    // a challenge (a temporary password not yet changed) gives no session to change with
    const token = auth.AuthenticationResult?.AccessToken;
    if (!token) return 'wrong_password';
    await this.client.send(
      new ChangePasswordCommand({
        AccessToken: token,
        PreviousPassword: current,
        ProposedPassword: next,
      }),
    );
    return 'ok';
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
  changeOwnPassword(): Promise<OwnPasswordResult> {
    return Promise.resolve('ok');
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
        env.COGNITO_CLIENT_ID,
      )
    : new NoopDirectory();
  return cached;
}
