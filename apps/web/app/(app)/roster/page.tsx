import { redirect } from 'next/navigation';
import type { SearchParams } from '@/lib/inventory';
import { peopleContext, tabAccess } from '@/lib/people';
import { rosterLanding } from '@/lib/roster-view';

// Roster opens on Team (the week roster) for roster builders and for people with no shifts
// of their own; everyone else on Me (their own shifts). ADR 025.
export default async function RosterPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await peopleContext(searchParams);
  const to = ctx.can('ROSTER') ? rosterLanding(tabAccess(ctx)) : null;
  if (!to) return <p className="text-slate-600">You don&apos;t have access to roster.</p>;
  redirect(to);
}
