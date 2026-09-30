import type { ClientBase } from 'pg';
import { loadCustomer, type LoadOptions, type LoadReport } from './apply';

// Creating a customer from the Platform Admin console (ADR 012, PRD ADM-2): the company
// root, product access, workflow definitions, the AI agent, the ACCOUNT_OWNER job role and
// the first account owner. It runs the onboarding loader on a minimal bundle, so a later
// full import upserts onto the same codes (the company root and the owner). Safe to run
// twice: the second run changes nothing.

export interface NewCustomer {
  code: string;
  name: string;
  country: string;
  currency: string;
  timezone: string;
  isTest: boolean;
  /**
   * The first account owner. An email owner gets Cognito's invitation; a username owner
   * (no email, e.g. the test customers' owners in their file 07) gets no email. The
   * username defaults to <code>.owner.
   */
  owner: {
    displayName: string;
    email: string | null;
    username?: string;
    loginType?: 'email' | 'username';
  };
}

export interface CreatedCustomer {
  report: LoadReport;
  tenantId?: string;
  ownerUsername: string;
}

const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
const csv = (header: string, rows: string[][]) =>
  [header, ...rows.map((r) => r.map(cell).join(','))].join('\n') + '\n';

/** The owner's username: <customer code>.owner (unique across customers with the code). */
export function ownerUsername(code: string): string {
  return `${code.toLowerCase()}.owner`;
}

export function customerBundle(c: NewCustomer): Record<string, string> {
  const code = c.code.toUpperCase();
  const loginType = c.owner.loginType ?? 'email';
  return {
    '00_customer.csv': csv('customer_code,company_name,country,currency,default_timezone,is_test', [
      [code, c.name, c.country, c.currency, c.timezone, c.isTest ? 'yes' : 'no'],
    ]),
    '01_org_nodes.csv': csv('node_code,name,kind,parent_code,timezone,outlet_format', [
      [code, c.name, 'company', '', c.timezone, ''],
    ]),
    '02_delivery_nodes.csv': csv(
      'node_code,name,kind,parent_code,timezone,holds_stock,is_main_store',
      [],
    ),
    '03_node_links.csv': csv('org_node_code,delivery_node_code,note', []),
    '06_job_roles.csv': csv(
      'job_role_code,job_title,outlet_format,usual_department,default_access',
      [['ACCOUNT_OWNER', 'Account Owner', 'any', '(company)', 'ACCOUNT_OWNER@whole_company']],
    ),
    '07_users.csv': csv(
      'username,display_name,job_role_code,home_node_code,login_type,email,employment_type,joined_on,password_mode',
      [
        [
          c.owner.username ?? ownerUsername(code),
          c.owner.displayName,
          'ACCOUNT_OWNER',
          code,
          loginType,
          loginType === 'email' ? (c.owner.email ?? '').trim().toLowerCase() : '',
          'full_time',
          '',
          '',
        ],
      ],
    ),
  };
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
