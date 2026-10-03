import Link from 'next/link';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { companySettings } from '@/lib/settings-data';
import { loadShell } from '@/lib/shell';
import { SettingsForm } from './settings-form';

// Targets and settings (R-4, ADR 031; PO-4, ADR 032). The reports compare each figure with
// its target and show it red only when it is worse by more than 2 points. Only the Account
// Owner changes them (COMPANY_SETTINGS modify, checked by core.set_company_settings); other
// administrators see them.
export default async function SettingsPage() {
  const shell = await loadShell();
  if (!shell.domains.has('USER_ACCESS') && !shell.domains.has('COMPANY_SETTINGS')) {
    return <p className="text-slate-700">You don&apos;t have access to administration.</p>;
  }
  const user = await requireUser();
  const settings = await withUser(user.id, companySettings);
  const owner = shell.domains.get('COMPANY_SETTINGS') === 'modify';
  return (
    <div className="space-y-4">
      <Link href="/admin" className="text-sm text-slate-600">
        ← Administration
      </Link>
      <h1 className="text-xl font-semibold">Targets and settings</h1>
      <p className="text-sm text-slate-600">
        For the whole company. A figure shows red only when it is more than 2 points worse than its
        target.{owner ? '' : ' Only the account owner can change these.'}
      </p>
      <SettingsForm settings={settings} canEdit={owner} />
    </div>
  );
}
