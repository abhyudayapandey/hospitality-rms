import { App, CliCredentialsStackSynthesizer, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { SECRET_PARAMS } from './config';
import { OutletOpsStack, tag, TAG_PATTERN } from './outlet-ops-stack';

// Synthesizes the stack (no AWS calls) and checks the Free-plan and security
// constraints from ADR 005.

const AMI = 'ami-0123456789abcdef0';
const CONFIG = {
  domainName: 'outletops.duckdns.org',
  alertEmail: 'ops@example.com',
  cognitoDomainPrefix: 'outlet-ops-test',
  githubRepo: 'abhyudayapandey/hospitality-rms',
  githubOwnerId: '33194509',
  githubRepoId: '1394585977',
  amiId: AMI,
};

function synth(config = CONFIG): Template {
  const stack = new OutletOpsStack(new App(), 'Test', {
    env: { region: 'ap-south-1', account: '123456789012' },
    synthesizer: new CliCredentialsStackSynthesizer(),
    config,
  });
  return Template.fromStack(stack);
}

let t: Template;
beforeAll(() => {
  t = synth();
});

const FORBIDDEN = [
  'AWS::EC2::NatGateway',
  'AWS::ElasticLoadBalancing::LoadBalancer',
  'AWS::ElasticLoadBalancingV2::LoadBalancer',
  'AWS::RDS::DBInstance',
  'AWS::RDS::DBCluster',
  'AWS::RDS::DBProxy',
  'AWS::SecretsManager::Secret',
  'AWS::Lambda::Function', // incl. hidden custom-resource Lambdas
  'AWS::SNS::Topic',
  'AWS::Amplify::App',
  'AWS::ECR::Repository',
];

describe('Free-plan cost guardrails', () => {
  it.each(FORBIDDEN)('has no %s', (type) => {
    t.resourceCountIs(type, 0);
  });

  it('has no interface VPC endpoints', () => {
    const endpoints = t.findResources('AWS::EC2::VPCEndpoint');
    for (const ep of Object.values(endpoints)) {
      expect((ep.Properties as { VpcEndpointType?: string }).VpcEndpointType).not.toBe('Interface');
    }
  });

  it('has only public subnets (no private or isolated ones)', () => {
    const subnets = Object.values(t.findResources('AWS::EC2::Subnet'));
    expect(subnets).toHaveLength(1);
    t.hasResourceProperties('AWS::EC2::Subnet', { MapPublicIpOnLaunch: true });
  });

  it('runs one t4g.small with IMDSv2, a 10 GiB encrypted gp3 root and an Elastic IP', () => {
    t.resourceCountIs('AWS::EC2::Instance', 1);
    t.hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 't4g.small',
      BlockDeviceMappings: [
        { DeviceName: '/dev/xvda', Ebs: { VolumeSize: 10, VolumeType: 'gp3', Encrypted: true } },
      ],
    });
    t.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: { MetadataOptions: { HttpTokens: 'required' } },
    });
    t.resourceCountIs('AWS::EC2::EIP', 1);
  });

  it('keeps Postgres on a separate, retained, encrypted 20 GiB gp3 data volume', () => {
    t.hasResource('AWS::EC2::Volume', {
      Properties: { Size: 20, VolumeType: 'gp3', Encrypted: true },
      DeletionPolicy: 'RetainExceptOnCreate',
      UpdateReplacePolicy: 'Retain',
    });
    t.resourceCountIs('AWS::EC2::VolumeAttachment', 1);
  });

  it('snapshots the data volume daily and keeps 7 (DLM)', () => {
    t.hasResourceProperties('AWS::DLM::LifecyclePolicy', {
      PolicyDetails: {
        TargetTags: [{ Key: 'Backup', Value: 'outlet-ops-daily' }],
        Schedules: [Match.objectLike({ RetainRule: { Count: 7 } })],
      },
    });
  });

  it('alerts at 50/80/100 % of a $20 monthly budget, excluding credits', () => {
    t.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: {
        BudgetLimit: { Amount: 20, Unit: 'USD' },
        TimeUnit: 'MONTHLY',
        CostTypes: { IncludeCredit: false },
      },
      NotificationsWithSubscribers: [50, 80, 100].map((threshold) =>
        Match.objectLike({ Notification: Match.objectLike({ Threshold: threshold }) }),
      ),
    });
  });

  it('tags every taggable resource with a CostProfile', () => {
    for (const type of [
      'AWS::EC2::Instance',
      'AWS::EC2::Volume',
      'AWS::S3::Bucket',
      'AWS::EC2::EIP',
    ]) {
      for (const r of Object.values(t.findResources(type))) {
        const tags = (r.Properties as { Tags?: { Key: string }[] }).Tags ?? [];
        expect(
          tags.map((x) => x.Key),
          type,
        ).toContain('CostProfile');
      }
    }
  });
});

describe('network exposure', () => {
  it('allows only 80 and 443 inbound; no SSH, no Postgres', () => {
    const sgs = Object.values(t.findResources('AWS::EC2::SecurityGroup'));
    const ingress = sgs.flatMap(
      (sg) =>
        (sg.Properties as { SecurityGroupIngress?: { FromPort: number; ToPort: number }[] })
          .SecurityGroupIngress ?? [],
    );
    expect(ingress.map((r) => [r.FromPort, r.ToPort]).sort()).toEqual([
      [443, 443],
      [80, 80],
    ]);
    t.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
  });
});

type Statement = { Action: string | string[]; Resource: unknown; Effect: string; Sid?: string };

function statements(roleLogicalIdPrefix: string): Statement[] {
  const policies = t.findResources('AWS::IAM::Policy');
  return Object.values(policies)
    .filter((p) =>
      JSON.stringify((p.Properties as { Roles: unknown }).Roles).includes(roleLogicalIdPrefix),
    )
    .flatMap(
      (p) =>
        (p.Properties as { PolicyDocument: { Statement: Statement[] } }).PolicyDocument.Statement,
    );
}

const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);

describe('least-privilege IAM', () => {
  it('instance role: no wildcard actions, no managed SSM core policy, no deletes', () => {
    const st = statements('InstanceRole');
    expect(st.length).toBeGreaterThan(0);
    for (const s of st) {
      for (const a of actions(s)) {
        expect(a, s.Sid).not.toMatch(/\*/);
        expect(a).not.toMatch(/Delete(Object|Bucket|Parameter)/);
      }
    }
    const role = Object.values(t.findResources('AWS::IAM::Role')).find((r) =>
      JSON.stringify(r).includes('ec2.amazonaws.com'),
    )!;
    expect(JSON.stringify(role)).not.toContain('AmazonSSMManagedInstanceCore');
  });

  it('instance role reads only its own parameters', () => {
    const read = statements('InstanceRole').find((s) => s.Sid === 'ReadOwnParameters')!;
    const text = JSON.stringify(read.Resource);
    for (const name of Object.values(SECRET_PARAMS)) expect(text).toContain(`parameter${name}`);
    expect(text).not.toMatch(/parameter\/\*|parameter\/outlet-ops\/prod\/\*"/);
  });

  it('only SSM agent and command-result actions use Resource "*"', () => {
    const allowedStar = new Set(['SsmAgent', 'ReadCommandResults']);
    const all = [...statements('InstanceRole'), ...statements('GithubDeployRole')];
    for (const s of all) {
      if (s.Resource === '*') expect(allowedStar.has(s.Sid ?? ''), s.Sid).toBe(true);
    }
  });

  it('Cognito: exactly the seven user-admin actions, on the customer pool only (ADR 011)', () => {
    const cognito = [...statements('InstanceRole'), ...statements('GithubDeployRole')].filter((s) =>
      actions(s).some((a) => a.startsWith('cognito-idp:')),
    );
    expect(cognito.map((s) => s.Sid)).toEqual(['CustomerLoginAdmin']);
    const s = cognito[0]!;
    expect(actions(s).sort()).toEqual(
      [
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminDisableUser',
        'cognito-idp:AdminEnableUser',
        'cognito-idp:AdminGetUser',
        'cognito-idp:AdminSetUserPassword',
        'cognito-idp:AdminUpdateUserAttributes',
        'cognito-idp:AdminUserGlobalSignOut',
      ].sort(),
    );
    const pools = Object.keys(t.findResources('AWS::Cognito::UserPool'));
    expect(pools).toHaveLength(1);
    expect(s.Resource).toEqual({ 'Fn::GetAtt': [pools[0], 'Arn'] });
  });

  it('deploy role: trusted only from the production environment of this repo', () => {
    t.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                // GitHub's immutable-id subject, as seen in CloudTrail on the failed deploy.
                'token.actions.githubusercontent.com:sub':
                  'repo:abhyudayapandey@33194509/hospitality-rms@1394585977:environment:production',
              },
            },
          }),
        ],
      },
    });
  });

  it('deploy role trust uses exact matches only (no wildcards, no StringLike)', () => {
    const roles = Object.values(t.findResources('AWS::IAM::Role')).filter((r) =>
      JSON.stringify(r).includes('token.actions.githubusercontent.com'),
    );
    expect(roles).toHaveLength(1);
    const trust = JSON.stringify(
      (roles[0]!.Properties as { AssumeRolePolicyDocument: unknown }).AssumeRolePolicyDocument,
    );
    expect(trust).not.toContain('StringLike');
    expect(trust).not.toContain('*');
  });

  it('deploy role can only upload releases and run the fixed deploy document', () => {
    const st = statements('GithubDeployRole');
    expect(st.flatMap(actions).sort()).toEqual([
      's3:PutObject',
      'ssm:GetCommandInvocation',
      'ssm:ListCommandInvocations',
      'ssm:SendCommand',
    ]);
    const send = st.find((s) => s.Sid === 'RunDeployDocumentOnAppInstance')!;
    expect(JSON.stringify(send.Resource)).toContain('document/OutletOps-Deploy');
    expect(JSON.stringify(send.Resource)).not.toContain('AWS-RunShellScript');
  });

  it('the deploy document only accepts a 40-char commit SHA', () => {
    t.hasResourceProperties('AWS::SSM::Document', {
      Name: 'OutletOps-Deploy',
      Content: Match.objectLike({
        parameters: { release: Match.objectLike({ allowedPattern: '^[0-9a-f]{40}$' }) },
      }),
    });
  });
});

describe('storage', () => {
  it('blocks public access, encrypts and enforces TLS on every bucket', () => {
    const buckets = t.findResources('AWS::S3::Bucket');
    expect(Object.keys(buckets)).toHaveLength(3); // deploy, backup, photo
    for (const b of Object.values(buckets)) {
      expect(b.Properties).toMatchObject({
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
          ],
        },
      });
    }
    const policies = JSON.stringify(t.findResources('AWS::S3::BucketPolicy'));
    expect(policies).toContain('aws:SecureTransport');
  });
});

describe('Cognito', () => {
  it('Essentials, email OTP + password, no self sign-up, no SMS', () => {
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolTier: 'ESSENTIALS',
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      Policies: Match.objectLike({
        SignInPolicy: { AllowedFirstAuthFactors: Match.arrayWith(['PASSWORD', 'EMAIL_OTP']) },
      }),
      EmailConfiguration: { EmailSendingAccount: 'COGNITO_DEFAULT' },
    });
    const pool = JSON.stringify(t.findResources('AWS::Cognito::UserPool'));
    expect(pool).not.toContain('SmsConfiguration');
    expect(pool).not.toContain('SMS_OTP');
  });

  it('public app client with PKCE code flow to the app domain only', () => {
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
      CallbackURLs: ['https://outletops.duckdns.org/auth/callback'],
      LogoutURLs: ['https://outletops.duckdns.org/login'],
      EnableTokenRevocation: true,
    });
  });
});

// Every tag key and value on every resource, in whichever shape the resource type uses:
// [{Key, Value}] lists (most types) or {key: value} maps (Cognito, SSM, ...).
const TAG_PROPS = ['Tags', 'UserPoolTags', 'ResourceTags', 'TargetTags', 'TagsToAdd'];
function collectTags(node: unknown, out: [string, unknown][]): void {
  if (Array.isArray(node)) {
    for (const x of node) collectTags(x, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (TAG_PROPS.includes(k)) {
      if (Array.isArray(v)) {
        for (const x of v as { Key: unknown; Value: unknown }[]) {
          out.push([String(x.Key), x.Key], [String(x.Key), x.Value]);
        }
      } else if (v && typeof v === 'object') {
        for (const [tk, tv] of Object.entries(v as Record<string, unknown>))
          out.push([tk, tk], [tk, tv]);
      }
    } else {
      collectTags(v, out);
    }
  }
}

describe('tags', () => {
  const resources = () =>
    Object.entries(t.toJSON().Resources as Record<string, { Properties?: unknown }>);

  it('every tag key and value on every resource uses only characters AWS accepts', () => {
    const bad: string[] = [];
    let count = 0;
    for (const [id, r] of resources()) {
      const tags: [string, unknown][] = [];
      collectTags(r.Properties, tags);
      for (const [key, value] of tags) {
        count++;
        if (typeof value !== 'string' || !TAG_PATTERN.test(value)) {
          bad.push(`${id}: ${key}=${JSON.stringify(value)}`);
        }
      }
    }
    expect(count).toBeGreaterThan(20); // the walk really found the tags
    expect(bad).toEqual([]);
  });

  it('the Cognito user pool carries the cost tags (map-shaped UserPoolTags)', () => {
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolTags: Match.objectLike({ CostProfile: 'always-free', CostNote: Match.anyValue() }),
    });
  });

  it('refuses at synth time the characters that failed the first deploy', () => {
    const stack = new Stack(new App(), 'TagCheck');
    for (const value of ['~$1.8/month', 'a, b', 'x; y', '(EIP)', '50%']) {
      expect(() => tag(stack, 'CostNote', value), value).toThrow(/characters AWS rejects/);
    }
    expect(() => tag(stack, 'Cost', '1.60 USD per month')).not.toThrow();
  });
});

describe('redeploy after a failed first create', () => {
  const all = () =>
    Object.entries(
      t.toJSON().Resources as Record<
        string,
        { Type: string; DeletionPolicy?: string; Properties?: Record<string, unknown> }
      >,
    );

  it('stateful resources are removed if the first create rolls back', () => {
    for (const type of ['AWS::S3::Bucket', 'AWS::EC2::Volume']) {
      for (const [id, r] of all().filter(([, r]) => r.Type === type)) {
        expect(['Delete', 'RetainExceptOnCreate', undefined], id).toContain(r.DeletionPolicy);
      }
    }
  });

  it('only the user pool survives a rollback, and it has no unique name to collide on', () => {
    const retained = all().filter(([, r]) => r.DeletionPolicy === 'Retain');
    expect(retained.map(([, r]) => r.Type)).toEqual(['AWS::Cognito::UserPool']);
  });

  it('no bucket has a fixed name', () => {
    for (const [id, r] of all().filter(([, r]) => r.Type === 'AWS::S3::Bucket')) {
      expect(r.Properties?.BucketName, id).toBeUndefined();
    }
  });
});

describe('pinned machine image (ADR 006)', () => {
  it("takes the instance's ImageId from context amiId, never from an SSM lookup", () => {
    t.hasResourceProperties('AWS::EC2::Instance', { ImageId: AMI });
    const params = Object.keys((t.toJSON() as { Parameters?: object }).Parameters ?? {});
    expect(params.filter((p) => /SsmParameterValue|ami|Ami/.test(p))).toEqual([]);
    expect(JSON.stringify(t.toJSON())).not.toContain('/aws/service/ami-amazon-linux');
  });

  it('follows a changed amiId (so the change is always deliberate)', () => {
    const other = synth({ ...CONFIG, amiId: 'ami-0fedcba9876543210' });
    other.hasResourceProperties('AWS::EC2::Instance', { ImageId: 'ami-0fedcba9876543210' });
  });
});

describe('wastage photos (ADR 006)', () => {
  const photoBucket = () => {
    const [id, b] = Object.entries(t.findResources('AWS::S3::Bucket')).find(([k]) =>
      k.startsWith('PhotoBucket'),
    )!;
    return { id, props: b.Properties as Record<string, unknown> };
  };

  it('is private, expires photos after 400 days and allows POST only from the app origin', () => {
    const { props } = photoBucket();
    expect(props.CorsConfiguration).toEqual({
      CorsRules: [
        {
          AllowedHeaders: ['*'],
          AllowedMethods: ['POST'],
          AllowedOrigins: ['https://outletops.duckdns.org'],
          MaxAge: 3000,
        },
      ],
    });
    expect(JSON.stringify(props.LifecycleConfiguration)).toContain('"Prefix":"wastage/"');
    expect(JSON.stringify(props.LifecycleConfiguration)).toContain('"ExpirationInDays":400');
  });

  it('lets the instance role put and get wastage/* in the photo bucket, nothing else', () => {
    const { id } = photoBucket();
    const st = statements('InstanceRole').filter((s) => JSON.stringify(s.Resource).includes(id));
    expect(st.map((s) => [s.Sid, actions(s).sort()])).toEqual([
      ['WastagePhotos', ['s3:GetObject', 's3:PutObject']],
    ]);
    expect(JSON.stringify(st[0]!.Resource)).toContain('/wastage/*');
  });

  it('tells the instance the bucket name through a config parameter', () => {
    t.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/outlet-ops/prod/config/photo_bucket',
      Type: 'String',
    });
  });
});
