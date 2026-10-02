import Link from 'next/link';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatMoney, formatWhen, processLabel } from '@/lib/format';
import { toAssign } from '@/lib/tasks';
import { InboxItem } from './inbox-item';

/** Where a request is decided when not (only) from the inbox, and whether to show buttons. */
function moduleLink(r: {
  process_type: string;
  step: string;
  subject_id: string;
  delivery_node_id: string | null;
  approve_via: string | null;
  payload: Record<string, unknown>;
}): { link?: { href: string; label: string }; inline: boolean } {
  switch (r.process_type) {
    case 'PURCHASE_ORDER':
      return {
        link: {
          href: `/stock/orders/${r.subject_id}?node=${r.delivery_node_id}`,
          label: 'View order',
        },
        inline: true,
      };
    case 'STOCK_ADJUSTMENT':
      // photos and lines are on the review screen, so decide there
      return {
        link: { href: `/stock/adjustments/${r.subject_id}`, label: 'Review' },
        inline: false,
      };
    case 'TRANSFER': {
      const node = r.step === 'dispatch' ? String(r.payload.from_node_id) : r.delivery_node_id;
      return {
        link: {
          href: `/stock/transfers/${r.subject_id}?node=${node}`,
          label: r.step === 'dispatch' ? 'Open to send' : 'Open to receive',
        },
        inline: false,
      };
    }
    case 'LEAVE':
      // the balance and the shifts approval would drop are on the review screen
      return { link: { href: `/leave/${r.subject_id}`, label: 'Review' }, inline: false };
    case 'SHIFT_SWAP':
      // approved through hr.approve_swap, which re-checks the rostering rules
      return { link: { href: `/roster/swaps/${r.subject_id}`, label: 'Review' }, inline: false };
    default:
      return { inline: r.approve_via !== 'module' };
  }
}

export default async function InboxPage() {
  const user = await requireUser();
  const { rows, assign } = await withUser(user.id, async (tx) => {
    const r = await sql<{
      request_id: string;
      process_type: string;
      step: string;
      activated_at: Date;
      amount: string | null;
      payload: Record<string, unknown>;
      subject_id: string;
      delivery_node_id: string | null;
      approve_via: string | null;
      initiator_name: string;
    }>`select request_id, process_type, step, activated_at, amount, payload, subject_id,
              delivery_node_id, approve_via, initiator_name
         from wf.my_inbox()`.execute(tx);
    return { rows: r.rows, assign: await toAssign(tx) };
  });
  return (
    <div className="space-y-4">
      <PollRefresh />
      <h1 className="text-xl font-semibold">Inbox</h1>
      {assign.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-500">To assign</h2>
          <ul data-testid="to-assign" className="space-y-2">
            {assign.map((a) => (
              <li key={a.id}>
                <Link
                  href={a.kind === 'expiry' ? `/tasks/${a.id}` : `/tasks/maintenance/${a.id}`}
                  className="flex min-h-14 items-center justify-between gap-2 rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{a.title}</span>
                    <span className="block truncate text-xs text-slate-500">
                      {a.kind === 'expiry' ? 'Expired batch' : 'Maintenance'} · {a.place_name}
                      {a.reported_by && ` · from ${a.reported_by}`} · {formatWhen(a.reported_at)}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm underline">Assign</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {rows.length === 0 && assign.length === 0 ? (
        <p className="rounded-xl bg-white p-6 text-center text-slate-600 ring-1 ring-slate-200">
          Nothing is waiting for you.
        </p>
      ) : rows.length === 0 ? null : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <InboxItem
              key={r.request_id}
              entry={{
                requestId: r.request_id,
                processLabel: processLabel(r.process_type),
                step: r.step,
                amount: formatMoney(r.amount),
                waitingSince: formatWhen(r.activated_at),
                from: r.initiator_name,
                ...moduleLink(r),
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
