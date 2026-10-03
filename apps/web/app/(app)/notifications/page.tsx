import Link from 'next/link';
import { Empty } from '@/components/messages';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { groupNotifications, type NotificationRow } from '@/lib/notifications-view';
import { loadShell } from '@/lib/shell';
import { MarkAllRead } from './mark-read';

// In-app notifications (roster published or changed, swap and leave decisions), grouped by
// kind and day: "5 new tasks" rather than five lines (U-21, ADR 035). Web push is Phase 2
// (ADR 008).
export default async function NotificationsPage() {
  const user = await requireUser();
  const shell = await loadShell();
  const tz = shell.nodes.find((n) => n.id === shell.home?.id)?.timezone ?? 'Asia/Kolkata';
  const all = await withUser(user.id, async (tx) => {
    const r = await sql<NotificationRow>`
      select id, kind, title, body, link, read_at, created_at from ops.notification
       where owner_user_id = core.current_user_id()
       order by created_at desc, id desc limit 50`.execute(tx);
    return r.rows;
  });
  const unread = all.filter((r) => !r.read_at).length;
  const rows = groupNotifications(all, tz);
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
            const read = !n.unread;
            const inner = (
              <>
                <span className="flex items-start justify-between gap-2">
                  <span className={read ? '' : 'font-semibold'}>{n.title}</span>
                  {!read && (
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
              <li key={n.key} data-count={n.count}>
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
