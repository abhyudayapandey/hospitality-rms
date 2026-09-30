// Shapes and labels shared by the platform console's pages (ADR 012, 013).

export interface PlatformCustomer {
  id: string;
  code: string;
  name: string;
  country: string | null;
  status: 'active' | 'suspended';
  is_test: boolean;
  user_count: number;
  last_activity: Date | null;
  created_at: Date;
}

const JOB_LABELS: Record<string, string> = {
  create_customer: 'Create customer',
  import_dry_run: 'Import: dry run',
  import_apply: 'Import: apply',
  invite_logins: 'Email invitations',
};

export function jobLabel(kind: string): string {
  return JOB_LABELS[kind] ?? kind;
}
