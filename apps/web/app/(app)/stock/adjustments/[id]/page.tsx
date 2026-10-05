import Link from 'next/link';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatMoney, formatWhen } from '@/lib/format';
import { formatQty, movementLabel } from '@/lib/inventory';
import { photosEnabled, presignPhotoView, wastageKeyPattern } from '@/lib/photos';
import { AdjustmentDecision } from './decision';

const REASON: Record<string, string> = {
  count_variance: 'Stock count difference',
  wastage: 'Wastage above the approval value',
  supplier_excess: 'Delivery above the order (+5%)',
};

// The approval screen for a STOCK_ADJUSTMENT: what would be posted, with photos.
export default async function AdjustmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const a = await sql<{
      id: string;
      tenant_id: string;
      delivery_node_id: string;
      node_name: string;
      reason: string;
      status: string;
      amount: string;
      wf_request_id: string;
      created_at: Date;
      initiator: string | null;
      recorded_by: string | null;
      can_view: boolean;
      pending_for_me: boolean;
    }>`
      select a.id, a.tenant_id, a.delivery_node_id, core.node_name(a.delivery_node_id) as node_name,
             a.reason, a.status, a.amount, a.wf_request_id, a.created_at,
             (select initiator_name from wf.my_inbox() where request_id = a.wf_request_id) as initiator,
             -- sent in the lead's name for the person who threw an expired batch away (ADR 021)
             (select payload ->> 'recorded_by_name' from wf.request where id = a.wf_request_id)
               as recorded_by,
             core.can('STOCK_ADJUSTMENTS', 'view', null, a.delivery_node_id) as can_view,
             exists (select 1 from wf.my_inbox() where request_id = a.wf_request_id) as pending_for_me
        from inv.stock_adjustment a where a.id = ${id}::uuid`.execute(tx);
    const lines = await sql<{
      id: string;
      name: string;
      base_uom: string;
      movement_type: string;
      qty: string;
      unit_cost: string;
      reason: string | null;
      photo_key: string | null;
    }>`
      select l.id, i.name, i.base_uom, l.movement_type, l.qty, l.unit_cost, l.reason, l.photo_key
        from inv.stock_adjustment_line l join inv.item i on i.id = l.item_id
       where l.adjustment_id = ${id}::uuid order by i.name`.execute(tx);
    return { a: a.rows[0], lines: lines.rows };
  });
  if (!data.a || !data.a.can_view) return <Empty>Adjustment not found.</Empty>;
  const { a, lines } = data;
  // Photos: only keys under this tenant and node, and only after the SQL can() above.
  const pattern = wastageKeyPattern(a.tenant_id, a.delivery_node_id);
  const photos = new Map<string, string>();
  if (photosEnabled()) {
    for (const l of lines) {
      if (l.photo_key && pattern.test(l.photo_key)) {
        photos.set(l.id, await presignPhotoView(l.photo_key));
      }
    }
  }
  return (
    <div className="space-y-4">
      <Link href="/inbox" className="text-sm text-slate-600">
        ← To do list
      </Link>
      <div className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
        <h1 className="text-lg font-semibold">{REASON[a.reason] ?? a.reason}</h1>
        <p className="text-sm text-slate-600">
          {a.node_name} · {formatWhen(a.created_at)}
          {a.initiator ? ` · by ${a.initiator}` : ''}
        </p>
        {a.recorded_by && (
          <p className="text-sm text-slate-600" data-testid="recorded-by">
            Thrown away by {a.recorded_by}; sent for them by the system
            {a.initiator ? ` on behalf of ${a.initiator}` : ''}.
          </p>
        )}
        <p className="mt-1 text-lg font-semibold tabular-nums">{formatMoney(a.amount)}</p>
        <p className="text-sm text-slate-600">Status: {a.status}</p>
      </div>
      <ul className="space-y-2">
        {lines.map((l) => (
          <li
            key={l.id}
            className="rounded-xl bg-white p-4 ring-1 ring-slate-200"
            data-testid="adjustment-line"
          >
            <div className="flex justify-between gap-2">
              <span>
                <span className="block font-medium">{l.name}</span>
                <span className="text-xs text-slate-500">
                  {movementLabel(l.movement_type, l.reason)}
                </span>
              </span>
              <span className="text-right tabular-nums">
                {Number(l.qty) > 0 ? '+' : ''}
                {formatQty(l.qty, l.base_uom)}
                <span className="block text-xs text-slate-500">
                  {formatMoney(Math.abs(Number(l.qty)) * Number(l.unit_cost))}
                </span>
              </span>
            </div>
            {photos.has(l.id) && (
              // eslint-disable-next-line @next/next/no-img-element -- short-lived presigned S3 URL
              <img
                src={photos.get(l.id)}
                alt={`Photo of ${l.name}`}
                className="mt-3 max-h-72 w-full rounded-lg object-contain"
                data-testid="adjustment-photo"
              />
            )}
            {l.photo_key && !photos.has(l.id) && (
              <p className="mt-2 text-xs text-slate-500">Photo attached (not viewable here).</p>
            )}
          </li>
        ))}
      </ul>
      {a.pending_for_me && <AdjustmentDecision requestId={a.wf_request_id} />}
    </div>
  );
}
