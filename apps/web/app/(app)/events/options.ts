import 'server-only';
import { sql, type Tx } from '@/lib/db';

export interface EventFormOptions {
  items: { id: string; name: string; base_uom: string }[];
  roles: { code: string; name: string }[];
}

/** Items (catalogue, if the user can see stock) and job roles for the requirement lines. */
export async function eventFormOptions(tx: Tx): Promise<EventFormOptions> {
  const items = await sql<{ id: string; name: string; base_uom: string }>`
    select id, name, base_uom from inv.item where archived_at is null order by name`.execute(tx);
  const roles = await sql<{ code: string; name: string }>`
    select code, name from hr.job_role where archived_at is null order by name`.execute(tx);
  return { items: items.rows, roles: roles.rows };
}
