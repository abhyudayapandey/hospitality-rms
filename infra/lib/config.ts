// Deploy-time settings, passed as CDK context (-c key=value). See docs/deploy.md.

export interface OutletOpsConfig {
  /** Public hostname of the app (the PWA), e.g. my.heysenior.app */
  domainName: string;
  /** Public hostname of the website (ADR 141), e.g. heysenior.app; www.<it> redirects to it */
  siteDomain: string;
  /**
   * Hostnames the app used to live at (ADR 141). Caddy keeps answering on them and sends
   * every request to the same path on domainName, so installed apps and bookmarks still work.
   */
  legacyDomains: string[];
  /** Budget alerts and the Let's Encrypt account e-mail */
  alertEmail: string;
  /** Cognito managed-login domain prefix: <prefix>.auth.ap-south-1.amazoncognito.com */
  cognitoDomainPrefix: string;
  /** The platform admins' pool domain prefix (ADR 012), e.g. outletops-ap-platform */
  platformCognitoDomainPrefix: string;
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

const HOSTNAME = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export const REGION = 'ap-south-1';
export const PARAM_PREFIX = '/outlet-ops/prod';

/** SecureString parameters created by infra/scripts/create-secrets.sh (not by CloudFormation). */
export const SECRET_PARAMS = {
  migrator: `${PARAM_PREFIX}/db/migrator`,
  appRw: `${PARAM_PREFIX}/db/app_rw`,
  wfExecutor: `${PARAM_PREFIX}/db/wf_executor`,
  platformLoader: `${PARAM_PREFIX}/db/platform_loader`,
  sessionSecret: `${PARAM_PREFIX}/web/session_secret`,
  /** Web Push signing key (ADR 137): only wf-execute loads it; the web gets the public half */
  vapidPrivate: `${PARAM_PREFIX}/web/vapid_private`,
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
  const hostname = (key: string, v: string): string => {
    if (!HOSTNAME.test(v)) throw new Error(`CDK context "${key}" must be a hostname, got "${v}".`);
    return v;
  };
  const domainName = hostname('domainName', required('domainName'));
  const siteDomain = hostname('siteDomain', required('siteDomain'));
  if (siteDomain === domainName) {
    throw new Error('CDK context "siteDomain" must differ from "domainName" (ADR 141).');
  }
  const legacy: unknown = get('legacyDomains') ?? [];
  if (!Array.isArray(legacy) || !legacy.every((d): d is string => typeof d === 'string')) {
    throw new Error('CDK context "legacyDomains" must be a list of hostnames.');
  }
  const legacyDomains = legacy.map((d) => hostname('legacyDomains', d.trim()));
  if (
    legacyDomains.some((d) => d === domainName || d === siteDomain || d === `www.${siteDomain}`)
  ) {
    throw new Error('CDK context "legacyDomains" must not list the app or website hostname.');
  }
  const oidc = get('githubOidcProviderArn');
  return {
    domainName,
    siteDomain,
    legacyDomains,
    alertEmail: required('alertEmail'),
    cognitoDomainPrefix: required('cognitoDomainPrefix'),
    platformCognitoDomainPrefix: required('platformCognitoDomainPrefix'),
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
