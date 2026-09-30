import Link from 'next/link';
import { Empty } from '@/components/messages';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { MarkAllRead } from './mark-read';

// In-app notifications (roster published or changed, swap and leave decisions). Web push
// is Phase 2 (ADR 008).
export default async function NotificationsPage() {
  const user = await requireUser();
  const rows = await withUser(user.id, async (tx) => {
    const r = await sql<{
      id: string;
      title: string;
      body: string | null;
      link: string | null;
      read_at: Date | null;
      created_at: Date;
    }>`
      select id, title, body, link, read_at, created_at from ops.notification
       where owner_user_id = core.current_user_id()
       order by created_at desc, id desc limit 50`.execute(tx);
    return r.rows;
  });
  const unread = rows.filter((r) => !r.read_at).length;
  return (
    <div className="space-y-4">
      <PollRefresh />
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Notifications</h1>
        {unread > 0 && <MarkAllRead />}
      </div>
      {rows.length === 0 ? (
        <Empty>Nothing yet.</Empty>
      ) : (
        <ul className="space-y-2" data-testid="notifications">
          {rows.map((n) => {
            const inner = (
              <>
                <span className="flex items-start justify-between gap-2">
                  <span className={n.read_at ? '' : 'font-semibold'}>{n.title}</span>
                  {!n.read_at && (
                    <span
                      aria-label="unread"
                      className="mt-1.5 size-2 shrink-0 rounded-full bg-rose-600"
                    />
                  )}
                </span>
                {n.body && <span className="block text-sm text-slate-600">{n.body}</span>}
                <span className="block text-xs text-slate-500">{formatWhen(n.created_at)}</span>
              </>
            );
            const cls = 'block rounded-xl bg-white p-4 ring-1 ring-slate-200';
            return (
              <li key={n.id}>
                {n.link ? (
                  <Link href={n.link} className={cls}>
                    {inner}
                  </Link>
                ) : (
                  <div className={cls}>{inner}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
