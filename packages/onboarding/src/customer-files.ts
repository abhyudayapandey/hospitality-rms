// The files a customer starts with when created in the Platform Admin console (ADR 012):
// the company, the ACCOUNT_OWNER job role and the first owner. Pure, so the console can show
// or extend them (an outlet from a template, ADR 062) without loading the loader.

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

export interface CreatePayload {
  code: string;
  name: string;
  country?: string;
  currency?: string;
  timezone?: string;
  is_test?: boolean;
  owner: {
    display_name: string;
    email?: string | null;
    username?: string | null;
    login_type?: 'email' | 'username' | null;
  };
}

export function newCustomerFrom(p: CreatePayload): NewCustomer {
  return {
    code: p.code,
    name: p.name.trim(),
    country: p.country?.trim() || 'India',
    currency: p.currency?.trim() || 'INR',
    timezone: p.timezone?.trim() || 'Asia/Kolkata',
    isTest: p.is_test === true,
    owner: {
      displayName: p.owner.display_name.trim(),
      email: p.owner.email ?? null,
      ...(p.owner.username ? { username: p.owner.username } : {}),
      loginType: p.owner.login_type ?? 'email',
    },
  };
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
      'job_role_code,job_title,outlet_format,usual_department,default_duties',
      [['ACCOUNT_OWNER', 'Account Owner', 'any', '(company)', 'OWNS_COMPANY_ACCOUNT']],
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
