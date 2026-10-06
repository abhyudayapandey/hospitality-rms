import type { ClientBase } from 'pg';
import { loadCustomer, type LoadOptions, type LoadReport } from './apply';
import { customerBundle, ownerUsername, type NewCustomer } from './customer-files';

export { customerBundle, ownerUsername, type NewCustomer } from './customer-files';

// Creating a customer from the Platform Admin console (ADR 012, PRD ADM-2): the company
// root, product access, workflow definitions, the AI agent, the ACCOUNT_OWNER job role and
// the first account owner. It runs the onboarding loader on a minimal bundle, so a later
// full import upserts onto the same codes (the company root and the owner). Safe to run
// twice: the second run changes nothing.

export interface CreatedCustomer {
  report: LoadReport;
  tenantId?: string;
  ownerUsername: string;
}

export async function createCustomer(
  client: ClientBase,
  c: NewCustomer,
  opts: LoadOptions = {},
): Promise<CreatedCustomer> {
  const report = await loadCustomer(client, customerBundle(c), opts);
  return {
    report,
    ...(report.tenantId ? { tenantId: report.tenantId } : {}),
    ownerUsername: c.owner.username ?? ownerUsername(c.code),
  };
}
