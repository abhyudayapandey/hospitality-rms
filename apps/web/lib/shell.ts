import 'server-only';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { requireUser, type CurrentUser } from './auth/server';
import { NODE_COOKIE } from './auth/session';
import { sql, withUser } from './db';

export interface NodeRow {
  id: string;
  type: 'org' | 'delivery';
  kind: string;
  name: string;
  depth: number;
  derived: boolean;
  timezone: string | null;
  holds_stock: boolean;
}

export interface Shell {
  user: CurrentUser;
  domains: Map<string, 'view' | 'modify'>;
  nodes: NodeRow[];
  currentNode: NodeRow | null;
  inboxCount: number;
  unreadCount: number;
}

/** Everything the app layout needs, in one withUser transaction. */
export const loadShell = cache(async (): Promise<Shell> => {
  const user = await requireUser();
  const selected = (await cookies()).get(NODE_COOKIE)?.value;
  return withUser(user.id, async (tx) => {
    const domains = await sql<{ domain: string; access: 'view' | 'modify' }>`
      select * from core.my_domains()`.execute(tx);
    const nodes = await sql<NodeRow>`
      select id, type, kind, name, depth, derived, timezone, holds_stock from core.nodes()`.execute(
      tx,
    );
    const inbox = await sql<{ n: number }>`select count(*)::int as n from wf.my_inbox()`.execute(
      tx,
    );
    const unread = await sql<{ n: number }>`
      select count(*)::int as n from ops.notification
       where owner_user_id = core.current_user_id() and read_at is null`.execute(tx);
    const own = nodes.rows.filter((n) => !n.derived);
    const currentNode = nodes.rows.find((n) => n.id === selected) ?? own[0] ?? null;
    return {
      user,
      domains: new Map(domains.rows.map((d) => [d.domain, d.access])),
      nodes: nodes.rows,
      currentNode,
      inboxCount: inbox.rows[0]?.n ?? 0,
      unreadCount: unread.rows[0]?.n ?? 0,
    };
  });
});
