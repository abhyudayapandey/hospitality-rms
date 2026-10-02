import Link from 'next/link';
import { loadShell } from '@/lib/shell';
import { GroupForm } from '../group-form';

// A new group for the company (ADR 027); the Account Owner only (core.save_custom_group).
export default async function NewGroupPage() {
  const shell = await loadShell();
  if (shell.domains.get('COMPANY_SETTINGS') !== 'modify') {
    return <p className="text-slate-700">Only the account owner can build access groups.</p>;
  }
  return (
    <div className="space-y-4">
      <Link href="/admin/groups" className="text-sm text-slate-600">
        ← Access groups
      </Link>
      <h1 className="text-xl font-semibold">New access group</h1>
      <GroupForm initial={null} />
    </div>
  );
}
