import { Icon } from '@/components/icon';
import { Empty } from '@/components/messages';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import {
  groupNotifications,
  notificationIcon,
  type NotificationRow,
} from '@/lib/notifications-view';
import { listLimit } from '@/lib/list-page';
import { param, type SearchParams } from '@/lib/params';
import { loadShell } from '@/lib/shell';
import { ShowMore } from '@/components/show-more';
import { MarkAllRead, NotificationItem } from './mark-read';

// In-app notifications (roster published or changed, swap and leave decisions), grouped by
// kind and day: "5 new tasks" rather than five lines (U-21, ADR 035). Web push is Phase 2
// (ADR 008).
const PAGE = 50;

export default async function NotificationsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const user = await requireUser();
  const shell = await loadShell();
  const { tz } = shell;
  // the newest 50, then Show more (ADR 052); one row past the page says there is more
  const n = listLimit(param(sp, 'n'), PAGE);
  const { page, unread } = await withUser(user.id, async (tx) => {
    const r = await sql<NotificationRow>`
      select id, kind, title, body, link, read_at, created_at from ops.notification
       where owner_user_id = core.current_user_id()
       order by created_at desc, id desc limit ${n + 1}`.execute(tx);
    // Mark all read reaches unread ones past the page too, so it asks SQL (ADR 169)
    const u = await sql<{ v: boolean }>`
      select exists (select 1 from ops.notification
                      where owner_user_id = core.current_user_id() and read_at is null) as v`.execute(
      tx,
    );
    return { page: r.rows, unread: u.rows[0]?.v ?? false };
  });
  const more = page.length > n;
  const rows = groupNotifications(page.slice(0, n), tz);
  return (
    <div className="space-y-4">
      <PollRefresh />
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Notifications</h1>
        {unread && <MarkAllRead />}
      </div>
      {rows.length === 0 ? (
        <Empty icon="bell">Nothing yet</Empty>
      ) : (
        <ul className="space-y-2" data-testid="notifications">
          {rows.map((n) => {
            const read = !n.unread;
            const inner = (
              <>
                {/* the picture of what it is about (ADR 108) */}
                <Icon name={notificationIcon(n.kind)} className="mt-0.5 size-7 text-brand-700" />
                <span className="min-w-0 flex-1">
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
                  <span className="block text-xs text-slate-500">
                    {formatWhen(n.created_at, tz)}
                  </span>
                </span>
              </>
            );
            const cls = 'flex items-start gap-3 rounded-xl bg-white p-4 ring-1 ring-slate-200';
            return (
              <li key={n.key} data-count={n.count}>
                <NotificationItem ids={n.ids} link={n.link} unread={!read} className={cls}>
                  {inner}
                </NotificationItem>
              </li>
            );
          })}
        </ul>
      )}
      {more && <ShowMore href={`/notifications?n=${n + PAGE}`} />}
    </div>
  );
}
