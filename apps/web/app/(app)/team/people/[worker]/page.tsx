import Link from 'next/link';
import { Initials } from '@/components/initials';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { backHref } from '@/lib/back';
import { formatDay } from '@/lib/dates';
import { withUser } from '@/lib/db';
import { param, type SearchParams } from '@/lib/inventory';
import { peopleContext, teamPeople } from '@/lib/people';
import { DeactivateForm } from '../deactivate-form';

// One person's page from Team → People (ADR 160): who they are, where they work and since when,
// and, for whoever may ask, Deactivate. It sits here, not on every row of the list, so a tap on
// the list never lands on it by mistake.
export default async function TeamPersonPage({
  params,
  searchParams,
}: {
  params: Promise<{ worker: string }>;
  searchParams: SearchParams;
}) {
  const { worker } = await params;
  const ctx = await peopleContext(searchParams, 'team_people');
  const sp = await searchParams;
  const back = backHref(
    param(sp, 'back'),
    ctx.node ? `/team/people?node=${ctx.node.id}` : '/team/people',
  );
  const backLink = (
    <Link
      href={back}
      className="inline-flex min-h-11 items-center text-sm text-slate-600 underline"
    >
      ← Back
    </Link>
  );
  if (!ctx.node) {
    return (
      <div className="space-y-4">
        {backLink}
        <Empty>You don&apos;t see anyone&apos;s records.</Empty>
      </div>
    );
  }
  const node = ctx.node;
  const user = await requireUser();
  const p = (await withUser(user.id, (tx) => teamPeople(tx, node.id))).find(
    (x) => x.worker_id === worker,
  );
  if (!p) {
    return (
      <div className="space-y-4">
        {backLink}
        <Empty>We couldn&apos;t open this. It may not be yours to see.</Empty>
      </div>
    );
  }
  return (
    <div className="space-y-4" data-testid="team-person" data-username={p.username ?? ''}>
      {backLink}
      <div className="flex items-center gap-3">
        <Initials name={p.name} />
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">{p.name}</h1>
          <p className="text-sm text-slate-600">
            {p.job_role} · {p.place}
          </p>
        </div>
      </div>
      <dl className="divide-y divide-slate-100 rounded-xl bg-white text-sm ring-1 ring-slate-200">
        {p.joined_on && (
          <div className="flex justify-between gap-3 px-4 py-3">
            <dt className="text-slate-500">Works here since</dt>
            <dd>{formatDay(p.joined_on)}</dd>
          </div>
        )}
        <div className="flex justify-between gap-3 px-4 py-3">
          <dt className="text-slate-500">Status</dt>
          <dd data-testid="team-person-status">
            {p.status !== 'active'
              ? 'Inactive'
              : p.waiting
                ? 'Deactivation waiting'
                : 'Working here'}
          </dd>
        </div>
      </dl>
      {p.can_deactivate && <DeactivateForm user={p.user_id} name={p.name} />}
    </div>
  );
}
