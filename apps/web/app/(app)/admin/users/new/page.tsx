import Link from 'next/link';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { NewPersonForm } from './new-person-form';

// Add a person (PRD USR-1): name, login type, job role and home place; the derived access
// is previewed (now or needs approval) before saving.
export default async function NewUserPage() {
  const user = await requireUser();
  let choices;
  try {
    choices = await withUser(user.id, async (tx) => ({
      jobRoles: (
        await sql<{ code: string; name: string }>`select * from core.admin_job_roles()`.execute(tx)
      ).rows,
      places: (
        await sql<{ id: string; name: string; type: string }>`
          select id, name, type from core.admin_places() where type = 'org'`.execute(tx)
      ).rows,
    }));
  } catch {
    return <p className="text-slate-700">You don&apos;t have access to administration.</p>;
  }
  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Add a person</h1>
        <Link href="/admin/users" className="text-sm text-slate-600">
          People
        </Link>
      </div>
      <NewPersonForm jobRoles={choices.jobRoles} places={choices.places} />
    </div>
  );
}
