import Link from 'next/link';
import { BackLink } from '@/components/back-link';
import { Empty, primaryButton } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { RequestNow } from '../transfers/[id]/request-story';

// What I asked for (ADR 115): each ask, where it is now, newest first; then Ask for something.
export default async function MyAsksPage() {
  const user = await requireUser();
  const asks = await withUser(
    user.id,
    async (tx) =>
      (
        await sql<{
          id: string;
          store: string;
          items: string;
          stage: string;
          words: string;
          created_at: Date;
        }>`select id::text, store, items, stage, words, created_at
             from inv.my_staff_asks(30)`.execute(tx)
      ).rows,
  );
  return (
    <div className="space-y-4">
      <BackLink fallback="/me" />
      <h1 className="text-xl font-semibold">What I asked for</h1>
      {asks.length === 0 ? (
        <Empty icon="box">Nothing asked for yet.</Empty>
      ) : (
        <ul className="space-y-2" data-testid="my-asks">
          {asks.map((a) => (
            <li key={a.id}>
              <Link
                href={`/stock/asks/${a.id}`}
                className="block space-y-2 rounded-xl bg-white p-3 ring-1 ring-slate-200"
              >
                <span className="block font-medium">{a.items}</span>
                <span className="block text-xs text-slate-500">
                  {a.store} · {formatWhen(a.created_at)}
                </span>
                <RequestNow stage={a.stage} words={a.words} />
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link href="/stock/asks/new" className={`${primaryButton} flex items-center justify-center`}>
        Ask for something
      </Link>
    </div>
  );
}
