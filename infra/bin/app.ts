import { App } from 'aws-cdk-lib';
import { OutletOpsStack } from '../lib/outlet-ops-stack';

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
new OutletOpsStack(app, 'OutletOps', {
  env: { region: 'ap-south-1', ...(account ? { account } : {}) },
});
