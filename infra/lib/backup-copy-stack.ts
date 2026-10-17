import { RemovalPolicy, Stack, Duration, aws_s3 as s3, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { backupCopyBucketName } from './config';
import { BACKUP_LOCK_DAYS, backupLifecycle, tag } from './outlet-ops-stack';

// The second copy of the backups (ADR 171, review M43), in Hyderabad (ap-south-2): S3
// replication from the main stack's BackupVault writes here. Same lock and lifecycle; nothing
// else in this region. Its fixed name is what the main stack's replication rule points at.
export class BackupCopyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    tag(this, 'Project', 'outlet-ops');
    const bucket = new s3.Bucket(this, 'BackupCopy', {
      bucketName: backupCopyBucketName(this.account),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      objectLockEnabled: true,
      objectLockDefaultRetention: s3.ObjectLockRetention.governance(
        Duration.days(BACKUP_LOCK_DAYS),
      ),
      lifecycleRules: backupLifecycle(),
      removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
    });
    tag(bucket, 'CostProfile', 'credits');
    tag(bucket, 'CostNote', 'S3 copy of the backups in Hyderabad - cents per month');
  }
}
