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
  jobStatus,
  licences,
  licenceStatus,
  TONE_CLASS,
  type ComplianceTab,
} from '@/lib/compliance';
import { sql, withUser } from '@/lib/db';
import { param, type SearchParams } from '@/lib/params';
import { placesFor } from '@/lib/places';
import { listHref } from '@/lib/stock-view';

// Compliance (ADR 069): the outlet's licences and its compliance calendar, with what is
// expiring and what is overdue. "All outlets" first when there are several (ADR 038); a
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
  const tab: ComplianceTab = isComplianceTab(raw) ? raw : 'licences';
  const node = all ? null : place.id;
  const { counts, lic, jobs, canAdd } = await withUser(shell.user.id, async (tx) => {
    const c = await complianceCounts(tx, node);
    const showLic = tab === 'licences' || tab === 'expiring';
    const l = showLic ? await licences(tx, node) : [];
    const j = showLic ? [] : await complianceJobs(tx, node);
    const add = await sql<{ v: boolean }>`
      select bool_or(core.can('COMPLIANCE', 'modify', p.id, null)) as v
        from unnest(${places.map((p) => p.id)}::uuid[]) p(id)`.execute(tx);
    return {
      counts: c,
      lic: tab === 'expiring' ? l.filter((x) => x.days_left !== null && x.days_left <= 90) : l,
      jobs: tab === 'overdue' ? j.filter((x) => x.days_left < 0) : j,
      canAdd: add.rows[0]?.v ?? false,
    };
  });
  const href = (t: ComplianceTab) => listHref('/compliance', { all, node: place.id, tab: t });

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
          { key: 'licences', label: 'Licences', count: counts.licences, href: href('licences') },
          { key: 'calendar', label: 'Calendar', count: counts.items, href: href('calendar') },
          { key: 'expiring', label: 'Expiring', count: counts.expiring, href: href('expiring') },
          { key: 'overdue', label: 'Overdue', count: counts.overdue, href: href('overdue') },
        ]}
      />
      {tab === 'licences' || tab === 'expiring' ? (
        lic.length === 0 ? (
          <Empty>
            {tab === 'expiring'
              ? 'No licence expires in the next 90 days.'
              : 'No licences here yet.'}
          </Empty>
        ) : (
          <ul className="space-y-2" data-testid="licences">
            {lic.map((l) => {
              const s = licenceStatus(l);
              return (
                <li key={l.id} data-testid="licence" data-name={l.name}>
                  <Link
                    href={`/compliance/licences/${l.id}`}
                    className="block rounded-xl bg-white p-4 ring-1 ring-slate-200"
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 font-medium">
                        {l.name}
                        {all && (
                          <span className="block text-xs font-normal text-slate-500">
                            {l.place_name}
                          </span>
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
                      {[l.number, l.expires_on && `to ${dayWords(l.expires_on)}`]
                        .filter(Boolean)
                        .join(' · ')}
                      {` · renewed by the ${l.renewal_role_name}`}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )
      ) : jobs.length === 0 ? (
        <Empty>{tab === 'overdue' ? 'Nothing is overdue.' : 'No calendar jobs here yet.'}</Empty>
      ) : (
        <ul className="space-y-2" data-testid="jobs">
          {jobs.map((j) => {
            const s = jobStatus(j);
            return (
              <li key={j.id} data-testid="job" data-name={j.name}>
                <Link
                  href={`/compliance/calendar/${j.id}`}
                  className="block rounded-xl bg-white p-4 ring-1 ring-slate-200"
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 font-medium">
                      {j.name}
                      <span className="block text-xs font-normal text-slate-500">
                        {j.place_name}
                      </span>
                    </span>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${TONE_CLASS[s.tone]}`}
                      data-testid="job-status"
                    >
                      {s.words}
                    </span>
                  </span>
                  <span className="mt-1 block truncate text-sm text-slate-600">
                    {everyWords(j.every_months)} · the {j.owner_role_name}
                    {j.last_done && ` · last done ${dayWords(j.last_done)}`}
                  </span>
                </Link>
              </li>
            );
          })}
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
