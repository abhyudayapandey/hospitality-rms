import { App, CliCredentialsStackSynthesizer } from 'aws-cdk-lib';
import { configFromContext, REGION } from '../lib/config';
import { OutletOpsStack } from '../lib/outlet-ops-stack';

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
new OutletOpsStack(app, 'OutletOps', {
  env: { region: REGION, ...(account ? { account } : {}) },
  // No file/image assets, so no CDK bootstrap stack (S3 + ECR) is needed (ADR 005).
  synthesizer: new CliCredentialsStackSynthesizer(),
  config: configFromContext((k) => app.node.tryGetContext(k)),
  description: 'Outlet Ops pilot: EC2 t4g.small + Postgres in Docker, Cognito, S3 (ap-south-1)',
});
