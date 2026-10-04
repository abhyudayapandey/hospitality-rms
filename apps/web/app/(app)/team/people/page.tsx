import { FilterList } from '@/components/filter-list';
import { Empty } from '@/components/messages';
import { PeopleHeader } from '@/components/people-header';
import { requireUser } from '@/lib/auth/server';
import { formatDay } from '@/lib/dates';
import { withUser } from '@/lib/db';
import type { SearchParams } from '@/lib/inventory';
import { peopleContext, teamPeople } from '@/lib/people';
import { DeactivateForm } from './deactivate-form';

// Team → People (UX-5, ADR 035): who works at the place, for HR and leads (WORKERS view).
// Someone who changes worker records there (HR, the outlet manager) can ask for a person to
// be deactivated; the security admin approves (hr.request_deactivation, DEACTIVATION).
export default async function TeamPeoplePage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await peopleContext(searchParams, 'team_people');
  if (!ctx.node) return <Empty>You don&apos;t see anyone&apos;s records.</Empty>;
  const node = ctx.node;
  const user = await requireUser();
  const people = await withUser(user.id, (tx) => teamPeople(tx, node.id));
  const active = people.filter((p) => p.status === 'active');
  const inactive = people.filter((p) => p.status !== 'active');
  return (
    <div className="space-y-4">
      <PeopleHeader ctx={ctx} active="/team/people" title="People" />
      <p className="text-sm text-slate-600" data-testid="people-count">
        {active.length} working here{inactive.length > 0 ? ` · ${inactive.length} inactive` : ''}
      </p>
      {people.length === 0 ? (
        <Empty>Nobody works here yet.</Empty>
      ) : (
        <FilterList
          testid="people"
          limit={15}
          searchFrom={10}
          noun="people"
          rows={people.map((p) => ({
            key: p.worker_id,
            text: `${p.name} ${p.job_role} ${p.place}`,
            attrs: {
              className: 'space-y-2 px-4 py-3',
              'data-testid': 'person',
              'data-username': p.username ?? '',
            },
            node: (
              <>
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block font-medium">{p.name}</span>
                    <span className="block text-xs text-slate-500">
                      {p.job_role} · {p.place}
                      {p.joined_on ? ` · since ${formatDay(p.joined_on)}` : ''}
                    </span>
                  </span>
                  {p.status !== 'active' ? (
                    <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                      Inactive
                    </span>
                  ) : p.waiting ? (
                    <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800">
                      Deactivation waiting
                    </span>
                  ) : null}
                </div>
                {p.can_deactivate && <DeactivateForm user={p.user_id} name={p.name} />}
              </>
            ),
          }))}
        />
      )}
    </div>
  );
}
