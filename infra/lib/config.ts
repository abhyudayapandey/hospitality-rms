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
  /** Numeric id of the repository owner: gh api repos/<owner>/<repo> --jq .owner.id */
  githubOwnerId: string;
  /** Numeric id of the repository: gh api repos/<owner>/<repo> --jq .id */
  githubRepoId: string;
  /**
   * The instance's Amazon Linux 2023 arm64 AMI, pinned so a deploy never replaces the
   * instance just because AWS published a newer image (ADR 006). For the running
   * instance: aws ec2 describe-instances --instance-ids <id> --query
   * 'Reservations[0].Instances[0].ImageId' --output text
   */
  amiId: string;
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
  const numericId = (key: string): string => {
    const raw = get(key);
    const v = typeof raw === 'number' ? String(raw) : required(key);
    if (!/^[1-9][0-9]*$/.test(v)) {
      throw new Error(`CDK context "${key}" must be a numeric GitHub id, got "${v}".`);
    }
    return v;
  };
  const githubRepo = required('githubRepo');
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(githubRepo)) {
    throw new Error(`CDK context "githubRepo" must be owner/repo, got "${githubRepo}".`);
  }
  const amiId = required('amiId');
  if (!/^ami-[0-9a-f]{8,17}$/.test(amiId)) {
    throw new Error(`CDK context "amiId" must look like ami-0123456789abcdef0, got "${amiId}".`);
  }
  const oidc = get('githubOidcProviderArn');
  return {
    domainName: required('domainName'),
    alertEmail: required('alertEmail'),
    cognitoDomainPrefix: required('cognitoDomainPrefix'),
    githubRepo,
    githubOwnerId: numericId('githubOwnerId'),
    githubRepoId: numericId('githubRepoId'),
    amiId,
    githubOidcProviderArn: typeof oidc === 'string' && oidc !== '' ? oidc : undefined,
  };
}

/**
 * The `sub` claim GitHub puts in the OIDC token of a job that runs in the repo's
 * `production` environment. GitHub's immutable-id subject format pins the owner and
 * repo ids, so a renamed or re-created repo with the same name cannot deploy:
 *   repo:<owner>@<ownerId>/<repo>@<repoId>:environment:production
 */
export function githubDeploySubject(
  config: Pick<OutletOpsConfig, 'githubRepo' | 'githubOwnerId' | 'githubRepoId'>,
): string {
  const [owner, repo] = config.githubRepo.split('/');
  return `repo:${owner}@${config.githubOwnerId}/${repo}@${config.githubRepoId}:environment:production`;
}
