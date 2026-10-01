import { redirect } from 'next/navigation';
import { loadShell } from '@/lib/shell';

// Managers, and people whose home is above outlet level (no shifts of their own), land on
// the week roster; everyone else on their own shifts.
export default async function RosterPage() {
  const shell = await loadShell();
  if (!shell.domains.has('ROSTER')) {
    return <p className="text-slate-600">You don&apos;t have access to roster.</p>;
  }
  redirect(
    shell.domains.get('ROSTER') === 'modify' || !shell.home?.at_workplace
      ? '/roster/week'
      : '/roster/my',
  );
}
