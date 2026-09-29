import { App, CliCredentialsStackSynthesizer } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { SECRET_PARAMS } from './config';
import { OutletOpsStack } from './outlet-ops-stack';

// Synthesizes the stack (no AWS calls) and checks the Free-plan and security
// constraints from ADR 005.

let t: Template;
beforeAll(() => {
  const app = new App();
  const stack = new OutletOpsStack(app, 'Test', {
    env: { region: 'ap-south-1', account: '123456789012' },
    synthesizer: new CliCredentialsStackSynthesizer(),
    config: {
      domainName: 'outletops.duckdns.org',
      alertEmail: 'ops@example.com',
      cognitoDomainPrefix: 'outlet-ops-test',
      githubRepo: 'abhyudayapandey/hospitality-rms',
    },
  });
  t = Template.fromStack(stack);
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
      DeletionPolicy: 'Retain',
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

  it('deploy role: trusted only from the production environment of this repo', () => {
    t.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub':
                  'repo:abhyudayapandey/hospitality-rms:environment:production',
              },
            },
          }),
        ],
      },
    });
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
    expect(Object.keys(buckets)).toHaveLength(2);
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
