import Link from 'next/link';
import { Empty } from '@/components/messages';
import { customGroups } from '@/lib/custom-groups-data';
import { withUser } from '@/lib/db';
import { loadShell } from '@/lib/shell';
import { GroupForm } from '../group-form';

// Edit one of the company's groups (ADR 027); the Account Owner only.
export default async function GroupPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const shell = await loadShell();
  if (shell.domains.get('COMPANY_SETTINGS') !== 'modify') {
    return <p className="text-slate-700">Only the account owner can change access groups.</p>;
  }
  const g = (await withUser(shell.user.id, customGroups)).find((x) => x.code === code);
  return (
    <div className="space-y-4">
      <Link href="/admin/groups" className="text-sm text-slate-600">
        ← Access groups
      </Link>
      <h1 className="text-xl font-semibold">{g?.name ?? 'Access group'}</h1>
      {g ? (
        <GroupForm
          initial={{
            code: g.code,
            name: g.name,
            rights: g.rights,
            actsAs: g.acts_as,
            holders: g.holders,
          }}
        />
      ) : (
        <Empty>That group doesn&apos;t exist.</Empty>
      )}
    </div>
  );
}
