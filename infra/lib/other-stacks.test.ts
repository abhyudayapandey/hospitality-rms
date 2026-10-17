import { App, CliCredentialsStackSynthesizer } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { BackupCopyStack } from './backup-copy-stack';
import { backupCopyBucketName } from './config';
import { MonitorStack } from './monitor-stack';

// The two small stacks of ADR 171: the backups' second copy (ap-south-2) and the outside check
// (us-east-1). Synthesized only; no AWS calls.

const env = (region: string) => ({ region, account: '123456789012' });

describe('the backups’ second copy (Hyderabad)', () => {
  const t = Template.fromStack(
    new BackupCopyStack(new App(), 'Copy', {
      env: env('ap-south-2'),
      synthesizer: new CliCredentialsStackSynthesizer(),
    }),
  );

  it('one private, encrypted, locked, versioned bucket, named as the main stack expects', () => {
    t.resourceCountIs('AWS::S3::Bucket', 1);
    t.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: backupCopyBucketName('123456789012'),
      VersioningConfiguration: { Status: 'Enabled' },
      ObjectLockEnabled: true,
      ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled',
        Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 35 } },
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    expect(JSON.stringify(t.findResources('AWS::S3::BucketPolicy'))).toContain(
      'aws:SecureTransport',
    );
  });

  it('is kept if the stack goes, and nothing else lives in that region', () => {
    const [bucket] = Object.values(t.findResources('AWS::S3::Bucket'));
    expect(bucket!.DeletionPolicy).toBe('RetainExceptOnCreate');
    const resources = t.toJSON() as { Resources: Record<string, { Type: string }> };
    const types = new Set(Object.values(resources.Resources).map((r) => r.Type));
    expect([...types].sort()).toEqual(['AWS::S3::Bucket', 'AWS::S3::BucketPolicy']);
  });
});

describe('the outside check (us-east-1)', () => {
  const t = Template.fromStack(
    new MonitorStack(new App(), 'Monitor', {
      env: env('us-east-1'),
      synthesizer: new CliCredentialsStackSynthesizer(),
      config: { domainName: 'outletops.duckdns.org', alertEmail: 'ops@example.com' },
    }),
  );

  it('asks http://<domain>/health every 30 seconds (a plain-HTTP check costs half)', () => {
    t.hasResourceProperties('AWS::Route53::HealthCheck', {
      HealthCheckConfig: {
        Type: 'HTTP',
        FullyQualifiedDomainName: 'outletops.duckdns.org',
        Port: 80,
        ResourcePath: '/health',
        RequestInterval: 30,
      },
    });
  });

  it('emails when it fails for 2 minutes, and again when it is back; no data counts as down', () => {
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/Route53',
      MetricName: 'HealthCheckStatus',
      EvaluationPeriods: 2,
      TreatMissingData: 'breaching',
    });
    const alarm = Object.values(t.findResources('AWS::CloudWatch::Alarm'))[0]!.Properties as {
      AlarmActions: unknown[];
      OKActions: unknown[];
    };
    expect(alarm.AlarmActions).toHaveLength(1);
    expect(alarm.OKActions).toHaveLength(1);
    t.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'ops@example.com',
    });
  });
});
