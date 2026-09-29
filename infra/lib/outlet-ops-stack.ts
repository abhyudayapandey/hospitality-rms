import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Size,
  Stack,
  Tags,
  aws_budgets as budgets,
  aws_cognito as cognito,
  aws_dlm as dlm,
  aws_ec2 as ec2,
  aws_iam as iam,
  aws_s3 as s3,
  aws_ssm as ssm,
  type StackProps,
  Validations,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import {
  CONFIG_PARAM_PATH,
  githubDeploySubject,
  PARAM_PREFIX,
  REGION,
  SECRET_PARAMS,
  type OutletOpsConfig,
} from './config';

// Outlet Ops pilot stack (ADR 005, docs/deploy.md). Free plan, ap-south-1:
//  * one EC2 t4g.small in a public subnet runs Caddy (TLS), the Next.js app, the
//    wf-execute timer and Postgres 16 in Docker bound to 127.0.0.1 (never public)
//  * no NAT gateway, load balancer, RDS, interface endpoints, Lambda or SMS
//  * a separate EBS data volume holds Postgres; DLM snapshots it daily
//  * SSM Parameter Store (standard tier) holds secrets; Cognito does sign-in
// Each resource carries a CostProfile tag: always-free or credits.

export interface OutletOpsStackProps extends StackProps {
  config: OutletOpsConfig;
}

const BACKUP_TAG = { key: 'Backup', value: 'outlet-ops-daily' };

/**
 * Characters AWS accepts in tag keys and values across services (Cognito is the
 * strictest): letters, numbers, spaces and _ . : / = + - @. No $ ~ , ; % or brackets.
 */
export const TAG_PATTERN = /^[\p{L}\p{Z}\p{N}_.:/=+\-@]*$/u;

export function tag(scope: Construct, key: string, value: string): void {
  for (const s of [key, value]) {
    if (!TAG_PATTERN.test(s)) throw new Error(`tag "${key}=${value}" has characters AWS rejects`);
  }
  Tags.of(scope).add(key, value);
}

function costTag(scope: Construct, profile: 'always-free' | 'credits', note: string): void {
  tag(scope, 'CostProfile', profile);
  tag(scope, 'CostNote', note);
}

export class OutletOpsStack extends Stack {
  constructor(scope: Construct, id: string, props: OutletOpsStackProps) {
    super(scope, id, props);
    const { config } = props;
    tag(this, 'Project', 'outlet-ops');

    // --- Network: one public subnet, no NAT, no isolated subnets --------------------
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
      // true would add a custom-resource Lambda; the default SG is unused anyway.
      restrictDefaultSecurityGroup: false,
    });
    costTag(vpc, 'always-free', 'VPC subnet route tables and internet gateway - no charge');

    const webSg = new ec2.SecurityGroup(this, 'WebSg', {
      vpc,
      description: 'Outlet Ops: HTTPS and HTTP (ACME + redirect) only. No SSH; use SSM.',
      allowAllOutbound: true,
    });
    webSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');
    webSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP (Lets Encrypt + redirect)');

    // --- Buckets --------------------------------------------------------------------
    const deployBucket = new s3.Bucket(this, 'DeployBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ prefix: 'releases/', expiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.DESTROY,
    });
    costTag(
      deployBucket,
      'credits',
      'S3 Standard release bundles expire after 30 days - cents per month',
    );

    const backupBucket = new s3.Bucket(this, 'BackupBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ prefix: 'pg/', expiration: Duration.days(30) }],
      // RetainExceptOnCreate: kept on stack delete/replace, but removed if the stack's
      // first create rolls back, so a failed deploy leaves no orphan behind.
      removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
    });
    costTag(
      backupBucket,
      'credits',
      'S3 Standard pg_dump every 6 h kept 30 days - cents per month',
    );

    // Wastage photos: private, written and read only through presigned URLs that the web
    // app issues with the instance role (POST: 5 MB, image types; GET: 5 minutes).
    const photoBucket = new s3.Bucket(this, 'PhotoBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ prefix: 'wastage/', expiration: Duration.days(400) }],
      // browsers upload straight to S3 from the app's origin only
      cors: [
        {
          allowedOrigins: [`https://${config.domainName}`],
          allowedMethods: [s3.HttpMethods.POST],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
    });
    costTag(
      photoBucket,
      'credits',
      'S3 Standard wastage photos about 200 KB each kept 400 days - under 0.01 USD per month',
    );

    // --- Instance role (least privilege) --------------------------------------------
    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Outlet Ops app instance',
    });
    // Minimum for Session Manager and Run Command. Not AmazonSSMManagedInstanceCore,
    // which also grants ssm:GetParameter(s) on every parameter in the account.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SsmAgent',
        actions: [
          'ssm:UpdateInstanceInformation',
          'ssmmessages:CreateControlChannel',
          'ssmmessages:CreateDataChannel',
          'ssmmessages:OpenControlChannel',
          'ssmmessages:OpenDataChannel',
          'ec2messages:AcknowledgeMessage',
          'ec2messages:DeleteMessage',
          'ec2messages:FailMessage',
          'ec2messages:GetEndpoint',
          'ec2messages:GetMessages',
          'ec2messages:SendReply',
        ],
        resources: ['*'], // these actions do not support resource-level permissions
      }),
    );
    const paramArn = (name: string) =>
      this.formatArn({
        service: 'ssm',
        resource: 'parameter',
        resourceName: name.replace(/^\//, ''),
      });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadOwnParameters',
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: Object.values(SECRET_PARAMS).map(paramArn),
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadConfigParameters',
        actions: ['ssm:GetParametersByPath'],
        resources: [paramArn(CONFIG_PARAM_PATH)],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadReleases',
        actions: ['s3:GetObject'],
        resources: [deployBucket.arnForObjects('releases/*')],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WriteAndReadBackups', // no s3:DeleteObject: lifecycle expires dumps
        actions: ['s3:PutObject', 's3:GetObject'],
        resources: [backupBucket.arnForObjects('pg/*')],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        // presigned POST (upload) and GET (approval screen) are signed with these rights
        sid: 'WastagePhotos',
        actions: ['s3:PutObject', 's3:GetObject'],
        resources: [photoBucket.arnForObjects('wastage/*')],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ListBackups',
        actions: ['s3:ListBucket'],
        resources: [backupBucket.bucketArn],
        conditions: { StringLike: { 's3:prefix': ['pg/*'] } },
      }),
    );

    // --- Instance + data volume + Elastic IP -----------------------------------------
    const subnet = vpc.publicSubnets[0]!;
    const dataVolume = new ec2.Volume(this, 'DataVolume', {
      availabilityZone: subnet.availabilityZone,
      size: Size.gibibytes(20),
      volumeType: ec2.EbsDeviceVolumeType.GP3,
      encrypted: true,
      // RetainExceptOnCreate, as for the backup bucket.
      removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
    });
    tag(dataVolume, BACKUP_TAG.key, BACKUP_TAG.value);
    costTag(dataVolume, 'credits', 'EBS gp3 20 GiB for Postgres data - about 1.80 USD per month');

    const userData = ec2.UserData.custom(
      readFileSync(join(import.meta.dirname, '..', 'instance', 'user-data.sh'), 'utf8').replace(
        '__DATA_VOLUME_ID__',
        dataVolume.volumeId,
      ),
    );

    const instance = new ec2.Instance(this, 'App', {
      vpc,
      vpcSubnets: { subnets: [subnet] },
      instanceType: new ec2.InstanceType('t4g.small'),
      // Pinned (context amiId): a newer AL2023 image must never replace the instance on
      // an unrelated deploy. Change amiId deliberately to move to a new image.
      machineImage: ec2.MachineImage.genericLinux({ [REGION]: config.amiId }),
      securityGroup: webSg,
      role,
      userData,
      requireImdsv2: true,
      ssmSessionPermissions: false, // granted explicitly above
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(10, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
    });
    costTag(
      instance,
      'credits',
      'EC2 t4g.small about 8.20 USD per month + 10 GiB gp3 root about 0.90 USD per month',
    );

    // The literal ImageId is the point of amiId (ADR 006), not a portability slip.
    Validations.of(instance).acknowledge({
      id: 'CloudFormation-Validate::W9010',
      reason: 'AMI pinned on purpose via context amiId (ADR 006)',
    });

    new ec2.CfnVolumeAttachment(this, 'DataVolumeAttachment', {
      instanceId: instance.instanceId,
      volumeId: dataVolume.volumeId,
      device: '/dev/sdf',
    });

    const eip = new ec2.CfnEIP(this, 'Eip', { domain: 'vpc', instanceId: instance.instanceId });
    costTag(eip, 'credits', 'Elastic IP public IPv4 0.005 USD per hour - about 3.65 USD per month');

    // --- Daily EBS snapshots of the data volume (DLM) --------------------------------
    const dlmRole = new iam.Role(this, 'DlmRole', {
      assumedBy: new iam.ServicePrincipal('dlm.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSDataLifecycleManagerServiceRole',
        ),
      ],
    });
    const snapshots = new dlm.CfnLifecyclePolicy(this, 'DataSnapshots', {
      description: 'Outlet Ops daily snapshot of the Postgres data volume - keep 7',
      state: 'ENABLED',
      executionRoleArn: dlmRole.roleArn,
      policyDetails: {
        policyType: 'EBS_SNAPSHOT_MANAGEMENT',
        resourceTypes: ['VOLUME'],
        targetTags: [BACKUP_TAG],
        schedules: [
          {
            name: 'daily-0000-IST',
            createRule: { interval: 24, intervalUnit: 'HOURS', times: ['18:30'] },
            retainRule: { count: 7 },
            copyTags: true,
          },
        ],
      },
    });
    costTag(
      snapshots,
      'credits',
      'EBS snapshots incremental 0.05 USD per GB-month - about 0.50 to 1.00 USD per month',
    );

    // --- Cognito: email OTP + username/password ---------------------------------------
    const userPool = new cognito.UserPool(this, 'Users', {
      userPoolName: 'outlet-ops',
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: false,
      signInAliases: { username: true, email: true },
      signInPolicy: { allowedFirstAuthFactors: { password: true, emailOtp: true } },
      autoVerify: { email: true },
      standardAttributes: { email: { required: false, mutable: true } },
      passwordPolicy: {
        minLength: 10,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: false,
        requireSymbols: false,
        tempPasswordValidity: Duration.days(7),
      },
      // Staff without e-mail cannot self-recover; outlet managers reset them (admin module).
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      email: cognito.UserPoolEmail.withCognito(), // Cognito sender: no SES, ~50 mails/day
      mfa: cognito.Mfa.OFF,
      deletionProtection: true,
      // Plain Retain: deletion protection would make a create rollback fail to delete it
      // (ROLLBACK_FAILED). The name is not unique, so a leftover pool never collides
      // with a redeploy; it costs nothing and docs/deploy.md says how to remove it.
      removalPolicy: RemovalPolicy.RETAIN,
    });
    costTag(
      userPool,
      'always-free',
      'Cognito Essentials - first 10000 MAU free - no SMS configured',
    );

    const client = userPool.addClient('Web', {
      generateSecret: false,
      authFlows: { user: true, userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PHONE],
        callbackUrls: [`https://${config.domainName}/auth/callback`],
        logoutUrls: [`https://${config.domainName}/login`],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      idTokenValidity: Duration.hours(1),
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });

    const domain = userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: config.cognitoDomainPrefix },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    new cognito.CfnManagedLoginBranding(this, 'LoginBranding', {
      userPoolId: userPool.userPoolId,
      clientId: client.userPoolClientId,
      useCognitoProvidedValues: true,
    });

    // --- Non-secret config for the instance (standard String parameters, free) -------
    const cognitoDomain = `${config.cognitoDomainPrefix}.auth.${this.region}.amazoncognito.com`;
    const cfg: Record<string, string> = {
      app_url: `https://${config.domainName}`,
      app_domain: config.domainName,
      acme_email: config.alertEmail,
      cognito_user_pool_id: userPool.userPoolId,
      cognito_client_id: client.userPoolClientId,
      cognito_domain: cognitoDomain,
      backup_bucket: backupBucket.bucketName,
      photo_bucket: photoBucket.bucketName,
    };
    for (const [name, value] of Object.entries(cfg)) {
      new ssm.StringParameter(this, `Config_${name}`, {
        parameterName: `${CONFIG_PARAM_PATH}/${name}`,
        stringValue: value,
        tier: ssm.ParameterTier.STANDARD,
      });
    }

    // --- Deploy: GitHub OIDC role -> S3 release + a fixed SSM command document ------
    const oidcArn =
      config.githubOidcProviderArn ??
      new iam.CfnOIDCProvider(this, 'GithubOidc', {
        url: 'https://token.actions.githubusercontent.com',
        clientIdList: ['sts.amazonaws.com'],
      }).attrArn;

    const deployDoc = new ssm.CfnDocument(this, 'DeployDocument', {
      name: 'OutletOps-Deploy',
      documentType: 'Command',
      updateMethod: 'NewVersion',
      content: {
        schemaVersion: '2.2',
        description: 'Download a release bundle from S3 and run its deploy script (ADR 005).',
        parameters: {
          release: {
            type: 'String',
            description: 'Git commit SHA of the release',
            allowedPattern: '^[0-9a-f]{40}$',
          },
        },
        mainSteps: [
          {
            action: 'aws:runShellScript',
            name: 'deploy',
            inputs: {
              timeoutSeconds: '1200',
              runCommand: [
                'set -euo pipefail',
                'REL="{{ release }}"',
                'DIR="/opt/outlet-ops/releases/$REL"',
                `aws s3 cp "s3://${deployBucket.bucketName}/releases/$REL.tgz" "/tmp/outlet-ops-$REL.tgz"`,
                'mkdir -p "$DIR" && tar -xzf "/tmp/outlet-ops-$REL.tgz" -C "$DIR" && rm -f "/tmp/outlet-ops-$REL.tgz"',
                '"$DIR/deploy/deploy.sh" "$REL"',
              ],
            },
          },
        ],
      },
    });

    const deployRole = new iam.Role(this, 'GithubDeployRole', {
      description: 'GitHub Actions deploy (environment: production) for Outlet Ops',
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(oidcArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          // Exact match, no wildcards (see githubDeploySubject).
          'token.actions.githubusercontent.com:sub': githubDeploySubject(config),
        },
      }),
    });
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'UploadRelease',
        actions: ['s3:PutObject'],
        resources: [deployBucket.arnForObjects('releases/*')],
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RunDeployDocumentOnAppInstance',
        actions: ['ssm:SendCommand'],
        resources: [
          this.formatArn({
            service: 'ssm',
            resource: 'document',
            resourceName: 'OutletOps-Deploy',
          }),
          this.formatArn({
            service: 'ec2',
            resource: 'instance',
            resourceName: instance.instanceId,
          }),
        ],
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadCommandResults',
        actions: ['ssm:GetCommandInvocation', 'ssm:ListCommandInvocations'],
        resources: ['*'], // no resource-level permissions for these read actions
      }),
    );
    deployRole.node.addDependency(deployDoc);

    // --- Budget: $20/month of real cost (credits excluded), alerts 50/80/100 % ------
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: 'outlet-ops-monthly',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: 20, unit: 'USD' },
        // Exclude credits so the budget tracks what the credits are paying for.
        costTypes: { includeCredit: false, includeRefund: false },
      },
      notificationsWithSubscribers: [50, 80, 100].map((threshold) => ({
        notification: {
          notificationType: 'ACTUAL',
          comparisonOperator: 'GREATER_THAN',
          threshold,
          thresholdType: 'PERCENTAGE',
        },
        subscribers: [{ subscriptionType: 'EMAIL', address: config.alertEmail }],
      })),
    });

    // --- Outputs ------------------------------------------------------------------
    new CfnOutput(this, 'PublicIp', {
      value: eip.attrPublicIp,
      description: 'Point DNS A record here',
    });
    new CfnOutput(this, 'InstanceId', { value: instance.instanceId });
    new CfnOutput(this, 'DeployBucketName', { value: deployBucket.bucketName });
    new CfnOutput(this, 'BackupBucketName', { value: backupBucket.bucketName });
    new CfnOutput(this, 'PhotoBucketName', { value: photoBucket.bucketName });
    new CfnOutput(this, 'DeployRoleArn', { value: deployRole.roleArn });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId });
    new CfnOutput(this, 'CognitoDomain', { value: domain.domainName });
    new CfnOutput(this, 'ParameterPrefix', { value: PARAM_PREFIX });
  }
}
