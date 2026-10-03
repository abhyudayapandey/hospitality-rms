// Notifications grouped by kind and day (UX review U-21, ADR 035): five "New task" rows of
// one day become "5 new tasks", two roster rows "Roster published for 2 weeks". A single
// notification stays as it is. Pure, so it can be unit tested.

import { localDate } from './dates';

export interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: Date | string | null;
  created_at: Date | string;
}

export interface NotificationGroup {
  key: string;
  title: string;
  /** the single notification's body; for a group, the first few titles */
  body: string | null;
  link: string | null;
  unread: boolean;
  count: number;
  created_at: Date | string;
  ids: string[];
}

/** What a group of one kind is called, and where it opens. */
const GROUPS: Readonly<Record<string, { title: (n: number) => string; link?: string }>> = {
  task_assigned: { title: (n) => `${n} new tasks`, link: '/tasks' },
  task_due_soon: { title: (n) => `${n} tasks due soon`, link: '/tasks' },
  task_overdue: { title: (n) => `${n} tasks overdue`, link: '/tasks' },
  roster_published: { title: (n) => `Roster published for ${n} weeks`, link: '/roster/my' },
  roster_changed: { title: (n) => `${n} roster changes`, link: '/roster/my' },
  negative_stock: { title: (n) => `${n} stores below zero after sales`, link: '/stock' },
  wastage: { title: (n) => `${n} wastage records`, link: '/stock/wastage' },
  maintenance_raised: { title: (n) => `${n} problems reported`, link: '/tasks/maintenance' },
};

/** Newest first; notifications of one kind on one day (local) become one line. */
export function groupNotifications(
  rows: readonly NotificationRow[],
  tz: string,
): NotificationGroup[] {
  const by = new Map<string, NotificationRow[]>();
  for (const r of rows) {
    const key = `${r.kind}:${localDate(r.created_at, tz)}`;
    by.set(key, [...(by.get(key) ?? []), r]);
  }
  return [...by.entries()]
    .map(([key, list]): NotificationGroup => {
      const sorted = [...list].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
      const first = sorted[0]!;
      const unread = sorted.some((r) => !r.read_at);
      const g = GROUPS[first.kind];
      if (sorted.length === 1) {
        return {
          key: first.id,
          title: first.title,
          body: first.body,
          link: first.link,
          unread,
          count: 1,
          created_at: first.created_at,
          ids: [first.id],
        };
      }
      // known kinds drop their generic prefix ("New task: ", "Overdue: ")
      const titles = sorted.map((r) => (g ? r.title.replace(/^[^:]+:\s*/, '') : r.title));
      const shown = [...new Set(titles)].slice(0, 3);
      const more = new Set(titles).size - shown.length;
      return {
        key,
        title: g ? g.title(sorted.length) : `${sorted.length} × ${first.title}`,
        body: `${shown.join(' · ')}${more > 0 ? ` · ${more} more` : ''}`,
        link: g?.link ?? first.link,
        unread,
        count: sorted.length,
        created_at: first.created_at,
        ids: sorted.map((r) => r.id),
      };
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}
