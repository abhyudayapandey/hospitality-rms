import Link from 'next/link';
import { backHref } from '@/lib/back';
import { Empty } from '@/components/messages';
import { NoSupplyAccess } from '@/components/supply-header';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { param, supplyContext, TRANSFER_PROGRESS, type SearchParams } from '@/lib/inventory';
import { TransferStepForm, type TransferLine } from './transfer-step-form';

export default async function TransferPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const ctx = await supplyContext(searchParams, 'transfers');
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const t = await sql<{
      id: string;
      from_node_id: string;
      to_node_id: string;
      from_name: string;
      to_name: string;
      progress: string;
      kind: string;
      wf_request_id: string;
      created_at: Date;
      dispatched_at: Date | null;
      received_at: Date | null;
      my_step: string | null;
    }>`select id, from_node_id, to_node_id, from_name, to_name, progress, kind, wf_request_id,
              created_at, dispatched_at, received_at, inv.my_transfer_step(id) as my_step
         from inv.transfer_summary where id = ${id}::uuid`.execute(tx);
    // lines the user may act on come through the step (a fallback approver may hold no
    // TRANSFERS rights there); otherwise as RLS allows
    const lines = t.rows[0]?.my_step
      ? await sql<TransferLine>`select * from inv.my_transfer_lines(${id}::uuid)`.execute(tx)
      : await sql<TransferLine>`
          select tl.item_id, i.name, i.base_uom, tl.requested_qty, tl.dispatched_qty,
                 tl.received_qty
            from inv.transfer_line tl join inv.item i on i.id = tl.item_id
           where tl.transfer_id = ${id}::uuid order by i.name`.execute(tx);
    return { t: t.rows[0], lines: lines.rows };
  });
  // readable with TRANSFERS rights, or while a step of it waits for this user (ADR 009)
  if (!data.t)
    return ctx.can('TRANSFERS') ? <Empty>Transfer not found.</Empty> : <NoSupplyAccess />;
  const { t, lines } = data;
  const [label, style] = TRANSFER_PROGRESS[t.progress] ?? [t.progress, ''];
  // Which side the user can act for is decided in SQL (the step they may act on), never here:
  // whoever runs the sending or the receiving location, through the approval chain.
  const mode =
    t.my_step === 'dispatch'
      ? 'dispatch'
      : t.my_step === 'receipt'
        ? 'receive'
        : t.my_step === 'approval'
          ? 'approve'
          : null;
  return (
    <div className="space-y-4">
      {ctx.node && (
        <Link
          href={backHref(param(await searchParams, 'back'), `/stock/transfers?node=${ctx.node.id}`)}
          className="text-sm text-slate-600"
        >
          ← Transfers
        </Link>
      )}
      <div className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
        <div className="flex items-baseline justify-between gap-2">
          {/* who asked first, then whom (ADR 077); a store's own send names the sender */}
          <div>
            <p className="text-xs font-medium text-slate-500" data-testid="transfer-kind">
              {t.kind === 'rfm'
                ? 'Request for material'
                : t.kind === 'send'
                  ? 'Sent'
                  : 'Stock request'}
            </p>
            <h1 className="text-lg font-semibold">
              {t.kind === 'send'
                ? `${t.from_name} sent to ${t.to_name}`
                : `${t.to_name} asked ${t.from_name}`}
            </h1>
          </div>
          <span
            data-testid="transfer-progress"
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${style}`}
          >
            {label}
          </span>
        </div>
        <p className="text-sm text-slate-600">
          Requested {formatWhen(t.created_at)}
          {t.dispatched_at && ` · sent ${formatWhen(t.dispatched_at)}`}
          {t.received_at && ` · received ${formatWhen(t.received_at)}`}
        </p>
      </div>
      <TransferStepForm transfer={t.id} requestId={t.wf_request_id} mode={mode} lines={lines} />
    </div>
  );
}
