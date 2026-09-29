import { loadShell } from '@/lib/shell';

export default async function RosterPage() {
  const shell = await loadShell();
  if (!shell.domains.has('ROSTER')) {
    return <p className="text-slate-600">You don&apos;t have access to roster.</p>;
  }
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Roster</h1>
      <p className="rounded-xl bg-white p-6 text-center text-slate-600 ring-1 ring-slate-200">
        Coming soon.
      </p>
    </div>
  );
}
