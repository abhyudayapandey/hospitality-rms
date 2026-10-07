import Link from 'next/link';
import { everyWords } from '@outlet-ops/domain';
import { Empty, secondaryButton } from '@/components/messages';
import { ModuleGate } from '@/components/module-gate';
import { PlaceSwitcher } from '@/components/place-switcher';
import { ViewTabs } from '@/components/view-tabs';
import {
  complianceCounts,
  complianceJobs,
  dayWords,
  isComplianceTab,
  jobPeople,
  jobStatus,
  licences,
  licenceStatus,
  needsAction,
  TONE_CLASS,
  type ComplianceTab,
  type JobRow,
  type LicenceRow,
} from '@/lib/compliance';
import { sql, withUser } from '@/lib/db';
import { param, type SearchParams } from '@/lib/params';
import { placesFor } from '@/lib/places';
import { listHref } from '@/lib/stock-view';

// Compliance (ADR 069, 073): what needs action first (licences within 90 days, regular jobs
// within 14), then every licence and every regular job. "All outlets" first when there are several (ADR 038); a
// tab's count is its whole list, counted in SQL (ADR 052). The list first, then what to do.

export default function CompliancePage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <ModuleGate code="compliance">
      <Compliance searchParams={searchParams} />
    </ModuleGate>
  );
}

async function Compliance({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const { shell, places, place } = await placesFor('compliance', searchParams);
  if (!place) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold">Compliance</h1>
        <Empty>You don&apos;t keep or see licences anywhere.</Empty>
      </div>
    );
  }
  const all = param(sp, 'all') === '1' && places.length > 1;
  const raw = param(sp, 'tab');
  const tab: ComplianceTab = isComplianceTab(raw) ? raw : 'action';
  const node = all ? null : place.id;
  const { counts, lic, jobs, canAdd } = await withUser(shell.user.id, async (tx) => {
    const add = await sql<{ v: boolean }>`
      select bool_or(core.can('COMPLIANCE', 'modify', p.id, null)) as v
        from unnest(${places.map((p) => p.id)}::uuid[]) p(id)`.execute(tx);
    return {
      counts: await complianceCounts(tx, node),
      lic: tab === 'jobs' ? [] : await licences(tx, node),
      jobs: tab === 'licences' ? [] : await complianceJobs(tx, node),
      canAdd: add.rows[0]?.v ?? false,
    };
  });
  const href = (t: ComplianceTab) => listHref('/compliance', { all, node: place.id, tab: t });
  const rows =
    tab === 'action'
      ? needsAction(lic, jobs)
      : tab === 'licences'
        ? lic.map((row) => ({ kind: 'licence' as const, row }))
        : jobs.map((row) => ({ kind: 'job' as const, row }));

  return (
    <div className="space-y-4">
      <PlaceSwitcher
        screen="compliance"
        places={places}
        current={place.id}
        all={places.length > 1 ? { label: 'All outlets', on: all } : undefined}
      />
      <h1 className="text-xl font-semibold">Compliance</h1>
      <ViewTabs
        label="Compliance view"
        current={tab}
        tabs={[
          {
            key: 'action',
            label: 'Needs action',
            count: counts.needs_action,
            href: href('action'),
          },
          { key: 'licences', label: 'Licences', count: counts.licences, href: href('licences') },
          { key: 'jobs', label: 'Regular jobs', count: counts.items, href: href('jobs') },
        ]}
      />
      {rows.length === 0 ? (
        <Empty>
          {tab === 'action'
            ? 'Nothing needs action: every licence is valid for 90 days and no job is due within 14.'
            : tab === 'licences'
              ? 'No licences here yet.'
              : 'No regular jobs here yet.'}
        </Empty>
      ) : (
        <ul className="space-y-2" data-testid="compliance-rows">
          {rows.map((r) =>
            r.kind === 'licence' ? (
              <LicenceItem key={`l-${r.row.id}`} l={r.row} all={all} />
            ) : (
              <JobItem key={`j-${r.row.id}`} j={r.row} />
            ),
          )}
        </ul>
      )}
      {canAdd && (
        <div className="grid grid-cols-2 gap-2">
          <Link
            href={`/compliance/licences/new?node=${place.id}`}
            className={`${secondaryButton} flex items-center justify-center`}
          >
            Add a licence
          </Link>
          <Link
            href={`/compliance/calendar/new?node=${place.id}`}
            className={`${secondaryButton} flex items-center justify-center`}
          >
            Add a job
          </Link>
        </div>
      )}
    </div>
  );
}

function LicenceItem({ l, all }: { l: LicenceRow; all: boolean }) {
  const s = licenceStatus(l);
  return (
    <li data-testid="licence" data-name={l.name}>
      <Link
        href={`/compliance/licences/${l.id}`}
        className="block rounded-xl bg-white p-4 ring-1 ring-slate-200"
      >
        <span className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 font-medium">
            {l.name}
            {all && (
              <span className="block text-xs font-normal text-slate-500">{l.place_name}</span>
            )}
          </span>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${TONE_CLASS[s.tone]}`}
            data-testid="licence-status"
          >
            {s.words}
          </span>
        </span>
        <span className="mt-1 block truncate text-sm text-slate-600">
          {[l.number, l.expires_on && `to ${dayWords(l.expires_on)}`].filter(Boolean).join(' · ')}
          {` · renewed by the ${l.renewal_role_name}`}
        </span>
      </Link>
    </li>
  );
}

function JobItem({ j }: { j: JobRow }) {
  const s = jobStatus(j);
  return (
    <li data-testid="job" data-name={j.name}>
      <Link
        href={`/compliance/calendar/${j.id}`}
        className="block rounded-xl bg-white p-4 ring-1 ring-slate-200"
      >
        <span className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 font-medium">
            {j.name}
            <span className="block text-xs font-normal text-slate-500">{j.place_name}</span>
          </span>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${TONE_CLASS[s.tone]}`}
            data-testid="job-status"
          >
            {s.words}
          </span>
        </span>
        <span className="mt-1 block text-sm text-slate-600">
          {everyWords(j.every_months)}
          {j.last_done && ` · last done ${dayWords(j.last_done)}`}
        </span>
        <span className="block text-sm text-slate-600" data-testid="job-people">
          {jobPeople(j)}
        </span>
      </Link>
    </li>
  );
}
