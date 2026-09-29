// Deploy-time settings, passed as CDK context (-c key=value). See docs/deploy.md.

export interface OutletOpsConfig {
  /** Public hostname of the app, e.g. outletops.duckdns.org or ops.example.com */
  domainName: string;
  /** Budget alerts and the Let's Encrypt account e-mail */
  alertEmail: string;
  /** Cognito managed-login domain prefix: <prefix>.auth.ap-south-1.amazoncognito.com */
  cognitoDomainPrefix: string;
  /** GitHub repository allowed to deploy, owner/repo */
  githubRepo: string;
  /** ARN of an existing GitHub OIDC provider in the account; one is created if unset */
  githubOidcProviderArn?: string | undefined;
}

export const REGION = 'ap-south-1';
export const PARAM_PREFIX = '/outlet-ops/prod';

/** SecureString parameters created by infra/scripts/create-secrets.sh (not by CloudFormation). */
export const SECRET_PARAMS = {
  migrator: `${PARAM_PREFIX}/db/migrator`,
  appRw: `${PARAM_PREFIX}/db/app_rw`,
  wfExecutor: `${PARAM_PREFIX}/db/wf_executor`,
  sessionSecret: `${PARAM_PREFIX}/web/session_secret`,
} as const;

export const CONFIG_PARAM_PATH = `${PARAM_PREFIX}/config`;

export function configFromContext(get: (key: string) => unknown): OutletOpsConfig {
  const required = (key: string): string => {
    const v = get(key);
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(`Missing CDK context "${key}". See docs/deploy.md (e.g. -c ${key}=...).`);
    }
    return v.trim();
  };
  const oidc = get('githubOidcProviderArn');
  return {
    domainName: required('domainName'),
    alertEmail: required('alertEmail'),
    cognitoDomainPrefix: required('cognitoDomainPrefix'),
    githubRepo: required('githubRepo'),
    githubOidcProviderArn: typeof oidc === 'string' && oidc !== '' ? oidc : undefined,
  };
}
