import Link from 'next/link';
import { ACCESS_GROUPS, summariseAccess } from '@outlet-ops/domain';
import { Empty } from '@/components/messages';
import { CARRIABLE_ROLES } from '@/lib/custom-groups';
import { customGroups, type CustomGroup } from '@/lib/custom-groups-data';
import { withUser } from '@/lib/db';
import { loadShell } from '@/lib/shell';

// Access groups (ADR 027): the company's own groups, which the Account Owner builds from
// the product's rights, and the product groups, read-only. Granting either to a person is
// on the person's page (People).
export default async function GroupsPage() {
  const shell = await loadShell();
  let groups: CustomGroup[] | null;
  try {
    groups = await withUser(shell.user.id, customGroups);
  } catch {
    groups = null;
  }
  if (groups === null) {
    return <p className="text-slate-700">You don&apos;t have access to administration.</p>;
  }
  const owner = shell.domains.get('COMPANY_SETTINGS') === 'modify';
  const roleName = (code: string) => CARRIABLE_ROLES.find((r) => r.code === code)?.name ?? code;
  return (
    <div className="space-y-6">
      <Link href="/admin" className="text-sm text-slate-600">
        ← Administration
      </Link>
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Access groups</h1>
        {owner && (
          <Link
            href="/admin/groups/new"
            className="flex min-h-11 items-center rounded-lg bg-slate-900 px-4 text-sm font-medium text-white"
          >
            New group
          </Link>
        )}
      </div>
      <section className="space-y-2">
        <h2 className="font-semibold">Your company&apos;s groups</h2>
        <p className="text-sm text-slate-600">
          Built from the product&apos;s rights for this company only. Give one to a person from
          People.{owner ? '' : ' Only the account owner can build or change them.'}
        </p>
        {groups.length === 0 ? (
          <Empty>No groups of your own yet.</Empty>
        ) : (
          <ul
            className="divide-y divide-slate-200 rounded-xl bg-white ring-1 ring-slate-200"
            data-testid="custom-groups"
          >
            {groups.map((g) => {
              const words = summariseAccess(
                Object.entries(g.rights).map(([domain, access]) => ({
                  domain,
                  access,
                })),
              );
              const body = (
                <>
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium">{g.name}</span>
                    <span className="text-xs text-slate-500">
                      {g.holders} {g.holders === 1 ? 'person' : 'people'}
                    </span>
                  </span>
                  {words.change.length > 0 && (
                    <span className="block text-sm">Change: {words.change.join(', ')}</span>
                  )}
                  {words.see.length > 0 && (
                    <span className="block text-sm">See: {words.see.join(', ')}</span>
                  )}
                  {g.acts_as.length > 0 && (
                    <span className="block text-sm">
                      Requests and approvals like: {g.acts_as.map(roleName).join(', ')}
                    </span>
                  )}
                  {g.sensitive && (
                    <span className="mt-1 inline-block rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800">
                      Giving it needs approval
                    </span>
                  )}
                </>
              );
              return (
                <li key={g.code} data-group={g.code}>
                  {owner ? (
                    <Link href={`/admin/groups/${g.code}`} className="block space-y-0.5 p-3">
                      {body}
                    </Link>
                  ) : (
                    <div className="space-y-0.5 p-3">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <details className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
        <summary className="min-h-11 cursor-pointer py-2 font-semibold">Product groups</summary>
        <ul className="divide-y divide-slate-100" data-testid="product-groups">
          {ACCESS_GROUPS.filter((g) => g.kind === 'role').map((g) => {
            const words = summariseAccess(
              Object.entries(g.grants).map(([domain, access]) => ({ domain, access })),
            );
            return (
              <li key={g.code} className="py-2 text-sm">
                <span className="block font-medium">{g.name}</span>
                {words.change.length > 0 && (
                  <span className="block">Change: {words.change.join(', ')}</span>
                )}
                {words.see.length > 0 && <span className="block">See: {words.see.join(', ')}</span>}
              </li>
            );
          })}
        </ul>
      </details>
    </div>
  );
}
