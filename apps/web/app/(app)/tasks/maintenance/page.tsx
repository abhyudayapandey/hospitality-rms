import Link from 'next/link';
import { Empty } from '@/components/messages';
import { TasksHeader } from '@/components/tasks-header';
import { ViewTabs } from '@/components/view-tabs';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { departmentSections } from '@/lib/department-groups';
import { param, type SearchParams } from '@/lib/params';
import { screenPlaces } from '@/lib/places';
import { loadShell } from '@/lib/shell';
import { maintenanceList, taskTabs, type Maintenance } from '@/lib/tasks';
import { listHref } from '@/lib/stock-view';
import type { PlaceDepartment } from '@/lib/today-view';

const STATUS: Record<string, string> = {
  open: 'open',
  assigned: 'assigned',
  in_progress: 'in progress',
  done: 'done',
};

// Maintenance (ADR 020): requests the person raised, their department's queue (Engineering
// staff), or those they manage. Raised anywhere they work; routed to the outlet's
// Engineering head, else up the tree. One screen (ADR 048): "All departments" first in the
// Place picker (what Home's open repairs count opens), each department a section, and a
// "To assign" tab for the repairs nobody has taken yet. Report a problem is at the end.
export default async function MaintenancePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const shell = await loadShell();
  const user = await requireUser();
  const wanted = param(sp, 'node');
  const tab = param(sp, 'tab') === 'assign' ? 'assign' : 'all';
  const data = await withUser(user.id, async (tx) => {
    const places = await screenPlaces(tx, 'maintenance', shell);
    const list = await maintenanceList(tx);
    const nodes = [...new Set(list.map((r) => r.place_node_id))];
    const depts =
      nodes.length > 0
        ? (
            await sql<PlaceDepartment>`
              select node_id::text, department_id::text, department, rank, outlet_id::text, outlet
                from core.department_of(${nodes}::uuid[])`.execute(tx)
          ).rows
        : [];
    return { tabs: await taskTabs(tx), places, list, depts };
  });
  // all departments unless one was chosen from the picker (not remembered, ADR 038)
  const chosen = data.places.find((p) => p.id === wanted) ?? null;
  const all = !chosen || param(sp, 'all') === '1';
  const current = chosen ?? data.places[0] ?? null;
  const inChosen = (r: Maintenance) => {
    if (all || !chosen) return true;
    const d = data.depts.find((x) => x.node_id === r.place_node_id);
    return (
      r.place_node_id === chosen.id ||
      d?.department_id === chosen.id ||
      (d?.outlet_id === chosen.id && d.department_id === null)
    );
  };
  const here = data.list.filter(inChosen);
  const toAssign = here.filter((r) => r.status === 'open');
  const shown = tab === 'assign' ? toAssign : here;
  const link = (t: string) =>
    listHref('/tasks/maintenance', { all, node: (all ? current?.id : chosen?.id) ?? null, tab: t });
  const sections = departmentSections(shown, data.depts, (r) => r.place_node_id);
  return (
    <div className="space-y-4">
      <PollRefresh />
      <TasksHeader
        tabs={data.tabs}
        active="/tasks/maintenance"
        title="Maintenance"
        switcher={
          current
            ? {
                screen: 'maintenance',
                places: data.places.map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
                current: current.id,
                all: { label: 'All departments', on: all },
              }
            : undefined
        }
      />
      <ViewTabs
        label="Maintenance view"
        current={tab}
        tabs={[
          { key: 'all', label: 'All repairs', href: link('all') },
          { key: 'assign', label: 'To assign', count: toAssign.length, href: link('assign') },
        ]}
      />
      {shown.length === 0 ? (
        <Empty>
          {tab === 'assign' ? 'Nothing is waiting to be assigned.' : 'No maintenance requests.'}
        </Empty>
      ) : (
        <div className="space-y-3" data-testid="maintenance">
          {sections.map((sec) => (
            <details
              key={sec.key}
              open
              className="rounded-xl bg-slate-50 p-2 ring-1 ring-slate-200"
              data-testid="department-section"
              data-department={sec.label}
            >
              <summary className="flex min-h-11 cursor-pointer items-center justify-between px-1 text-sm font-semibold">
                <span>{sec.label}</span>
                <span className="font-normal text-slate-600">{sec.rows.length}</span>
              </summary>
              <ul className="mt-1 divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
                {sec.rows.map((r) => (
                  <li key={r.id}>
                    <Link
                      href={`/tasks/maintenance/${r.id}`}
                      className="flex min-h-14 items-center justify-between gap-2 px-4 py-3"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{r.title}</span>
                        <span className="block truncate text-xs text-slate-500">
                          {r.place_name} · reported {formatWhen(r.created_at)}
                        </span>
                        {r.assigned_to_name && (
                          <span
                            className="block truncate text-xs text-slate-500"
                            data-testid="repair-who"
                          >
                            {r.assigned_to === user.id ? 'You' : r.assigned_to_name}
                            {r.assigned_at && ` · given ${formatWhen(r.assigned_at)}`}
                          </span>
                        )}
                      </span>
                      <span
                        className={`shrink-0 text-xs ${r.status === 'done' ? 'text-emerald-700' : 'text-slate-600'}`}
                      >
                        {STATUS[r.status]}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}
      {/* at the end of the list, not above it (UX) */}
      <Link
        href="/tasks/maintenance/new"
        className="flex min-h-12 items-center justify-center rounded-xl bg-brand-700 font-medium text-white"
      >
        Report a problem
      </Link>
    </div>
  );
}
