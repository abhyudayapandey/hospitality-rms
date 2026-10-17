import { App, CliCredentialsStackSynthesizer } from 'aws-cdk-lib';
import { BackupCopyStack } from '../lib/backup-copy-stack';
import { BACKUP_COPY_REGION, configFromContext, MONITOR_REGION, REGION } from '../lib/config';
import { MonitorStack } from '../lib/monitor-stack';
import { OutletOpsStack } from '../lib/outlet-ops-stack';

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
const env = (region: string) => ({ region, ...(account ? { account } : {}) });
const config = configFromContext((k) => app.node.tryGetContext(k));
// No file/image assets, so no CDK bootstrap stack (S3 + ECR) is needed in any region (ADR 005).
const synthesizer = () => new CliCredentialsStackSynthesizer();

// The backups' second copy first: the main stack's replication rule writes to it (ADR 170).
const copy = new BackupCopyStack(app, 'OutletOpsBackupCopy', {
  env: env(BACKUP_COPY_REGION),
  synthesizer: synthesizer(),
  description: 'Outlet Ops: the second copy of the database backups (ap-south-2)',
});
const main = new OutletOpsStack(app, 'OutletOps', {
  env: env(REGION),
  synthesizer: synthesizer(),
  config,
  description: 'Outlet Ops pilot: EC2 t4g.small + Postgres in Docker, Cognito, S3 (ap-south-1)',
});
main.addStackDependency(copy);
new MonitorStack(app, 'OutletOpsMonitor', {
  env: env(MONITOR_REGION),
  synthesizer: synthesizer(),
  config,
  description: 'Outlet Ops: the outside check of /health and its alarm (us-east-1)',
});
