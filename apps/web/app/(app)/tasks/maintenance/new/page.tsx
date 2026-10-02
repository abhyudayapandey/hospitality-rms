import { TasksHeader } from '@/components/tasks-header';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { photosEnabled } from '@/lib/photos';
import { placesFor } from '@/lib/places';
import type { SearchParams } from '@/lib/params';
import { taskTabs } from '@/lib/tasks';
import { ReportForm } from '../maintenance-forms';

export default async function ReportProblemPage({ searchParams }: { searchParams: SearchParams }) {
  const { places, place } = await placesFor('report', searchParams);
  const user = await requireUser();
  const tabs = await withUser(user.id, (tx) => taskTabs(tx));
  return (
    <div className="space-y-4">
      <TasksHeader
        tabs={tabs}
        active="/tasks/maintenance"
        title="Report a problem"
        switcher={
          place
            ? {
                screen: 'report',
                places: places.map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
                current: place.id,
                // most people report where they work (UX U-8)
                collapsed: true,
              }
            : undefined
        }
      />
      {place ? (
        <ReportForm place={place.id} photos={photosEnabled()} />
      ) : (
        <p className="rounded-xl bg-white p-6 text-center text-slate-600 ring-1 ring-slate-200">
          You don&apos;t work at a place where problems can be reported.
        </p>
      )}
    </div>
  );
}
