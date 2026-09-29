import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatMoney, formatWhen, processLabel } from '@/lib/format';
import { InboxItem } from './inbox-item';

export default async function InboxPage() {
  const user = await requireUser();
  const rows = await withUser(user.id, async (tx) => {
    const r = await sql<{
      request_id: string;
      process_type: string;
      step: string;
      activated_at: Date;
      amount: string | null;
    }>`select request_id, process_type, step, activated_at, amount from wf.my_inbox()`.execute(tx);
    return r.rows;
  });
  return (
    <div className="space-y-4">
      <PollRefresh />
      <h1 className="text-xl font-semibold">Inbox</h1>
      {rows.length === 0 ? (
        <p className="rounded-xl bg-white p-6 text-center text-slate-600 ring-1 ring-slate-200">
          Nothing is waiting for you.
        </p>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <InboxItem
              key={r.request_id}
              entry={{
                requestId: r.request_id,
                processLabel: processLabel(r.process_type),
                step: r.step,
                amount: formatMoney(r.amount),
                waitingSince: formatWhen(r.activated_at),
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
