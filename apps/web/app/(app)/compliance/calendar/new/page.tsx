import Link from 'next/link';
import { Empty } from '@/components/messages';
import { ModuleGate } from '@/components/module-gate';
import { withUser } from '@/lib/db';
import { placesFor } from '@/lib/places';
import type { SearchParams } from '@/lib/params';
import { keptPlaces, rolesByPlace } from '../../data';
import { JobForm } from '../../job-form';

// Add a calendar job (ADR 069) at an outlet or department where the person keeps the register.
export default function NewJobPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <ModuleGate code="compliance">
      <NewJob searchParams={searchParams} />
    </ModuleGate>
  );
}

async function NewJob({ searchParams }: { searchParams: SearchParams }) {
  const { shell, places, place } = await placesFor('compliance', searchParams);
  const { kept, roles } = await withUser(shell.user.id, async (tx) => {
    const k = await keptPlaces(tx, places);
    // the chosen outlet first
    k.sort((a, b) => (a.id === place?.id ? -1 : b.id === place?.id ? 1 : 0));
    return {
      kept: k,
      roles: await rolesByPlace(
        tx,
        k.map((p) => p.id),
      ),
    };
  });
  return (
    <div className="space-y-4">
      <Link href="/compliance" className="text-sm text-slate-600 underline">
        Back to Compliance
      </Link>
      <h1 className="text-xl font-semibold">Add a calendar job</h1>
      {kept.length === 0 ? (
        <Empty>You don&apos;t keep the compliance calendar anywhere.</Empty>
      ) : (
        <JobForm places={kept.map((p) => ({ id: p.id, name: p.name }))} roles={roles} />
      )}
    </div>
  );
}
