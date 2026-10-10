import Link from 'next/link';
import { BackLink } from '@/components/back-link';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { mySops } from '@/lib/training';

// Me → SOPs (ADR 095): the SOPs for my place and job role, the ones still to confirm first.
export default async function MySopsPage() {
  const user = await requireUser();
  const sops = await withUser(user.id, (tx) => mySops(tx));
  return (
    <div className="space-y-4">
      <BackLink />
      <h1 className="text-xl font-semibold">My SOPs</h1>
      {sops.length === 0 ? (
        <Empty>There are no SOPs for your job yet.</Empty>
      ) : (
        <ul
          className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
          data-testid="my-sops"
        >
          {sops.map((s) => (
            <li key={s.id} data-testid="my-sop">
              <Link
                href={`/me/sops/${s.id}`}
                className="flex min-h-11 items-center justify-between gap-3 px-4 py-3"
              >
                <span className="min-w-0">
                  <span className="block font-medium">{s.title}</span>
                  <span className="block text-xs text-slate-500">{s.place}</span>
                </span>
                {s.needs_ack && (
                  <span
                    className={`shrink-0 text-xs ${s.acked ? 'text-emerald-700' : 'text-amber-800'}`}
                    data-testid="sop-ack"
                  >
                    {s.acked ? 'Read' : 'To read'}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
