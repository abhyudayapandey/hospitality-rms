import Link from 'next/link';
import { redirect } from 'next/navigation';
import { backHref } from '@/lib/back';
import { Empty } from '@/components/messages';
import { NoSupplyAccess } from '@/components/supply-header';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { param, supplyContext, TRANSFER_PROGRESS, type SearchParams } from '@/lib/inventory';
import { requestActions } from '@/lib/request-actions';
import { RequestActions } from './request-actions';
import { RequestNow, RequestStory } from './request-story';

export default async function TransferPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const user = await requireUser();
  // one request, one screen (ADR 147): a request made for someone's ask opens on the ask
  const ask = await withUser(
    user.id,
    async (tx) =>
      (
        await sql<{ ask: string | null }>`
          select inv.request_ask(${id}::uuid)::text as ask`.execute(tx)
      ).rows[0]?.ask ?? null,
  ).catch(() => null);
  if (ask) redirect(`/stock/asks/${ask}`);
  const ctx = await supplyContext(searchParams, 'transfers');
  const { tz } = ctx.shell;
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
    if (!t.rows[0]) return { t: undefined, now: null, story: [], forAsk: null, actions: null };
    // where it is now and what happened (ADR 115), for whoever may follow it
    const now = (
      await sql<{ stage: string; words: string }>`
        select stage, words from inv.request_now(${id}::uuid)`.execute(tx)
    ).rows[0];
    const story = (
      await sql<{ at: Date; words: string }>`
        select at, words from inv.request_story(${id}::uuid)`.execute(tx)
    ).rows;
    // the frontline ask behind it: who asked, and why (ADR 142)
    const forAsk = (
      await sql<{ asked_by: string; note: string | null }>`
        select asked_by, note from inv.request_for_ask(${id}::uuid)`.execute(tx)
    ).rows[0];
    // every button the viewer may use on it (ADR 147), the same as on the ask's page
    const actions = await requestActions(tx, id);
    return {
      t: t.rows[0],
      now: now ?? null,
      story,
      forAsk: forAsk ?? null,
      actions,
    };
  });
  // readable with TRANSFERS rights, or while a step of it waits for this user (ADR 009)
  if (!data.t)
    return ctx.can('TRANSFERS') ? <Empty>Transfer not found.</Empty> : <NoSupplyAccess />;
  const { t, now, story, forAsk, actions } = data;
  const [label, style] = TRANSFER_PROGRESS[t.progress] ?? [t.progress, ''];
  return (
    <div className="space-y-4">
      {ctx.node && (
        <Link
          href={backHref(param(await searchParams, 'back'), `/stock/transfers?node=${ctx.node.id}`)}
          className="text-sm text-slate-600"
        >
          ← Back
        </Link>
      )}
      <div className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
        <div className="flex items-baseline justify-between gap-2">
          {/* who asked first, then whom (ADR 083); a store's own send names the sender */}
          <div>
            <p className="text-xs font-medium text-slate-500" data-testid="transfer-kind">
              {t.kind === 'send' ? 'Sent' : 'Request'}
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
        {forAsk && (
          <p className="mt-1 text-sm text-slate-800" data-testid="for-ask">
            For {forAsk.asked_by}
            {forAsk.note && `: ${forAsk.note}`}
          </p>
        )}
        <p className="text-sm text-slate-600">
          Requested {formatWhen(t.created_at, tz)}
          {t.dispatched_at && ` · sent ${formatWhen(t.dispatched_at, tz)}`}
          {t.received_at && ` · received ${formatWhen(t.received_at, tz)}`}
        </p>
      </div>
      {now && <RequestNow stage={now.stage} words={now.words} />}
      {actions && <RequestActions data={actions} />}
      <RequestStory story={story} tz={tz} />
    </div>
  );
}
