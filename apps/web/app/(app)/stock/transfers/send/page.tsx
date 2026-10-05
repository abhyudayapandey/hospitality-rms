import Link from 'next/link';
import { NoSupplyAccess } from '@/components/supply-header';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { isUuid, param, supplyContext, type SearchParams } from '@/lib/inventory';
import { SendStockForm, type SendItem } from './send-stock-form';

// Send stock (ADR 051): the Main Store gives stock to a department's store. First the
// department, then what to send; the person on shift there confirms what arrived.
export default async function SendStockPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await supplyContext(searchParams, 'transfers');
  if (!ctx.can('TRANSFERS', 'modify') || !ctx.node || ctx.node.derived) return <NoSupplyAccess />;
  const sp = await searchParams;
  const to = param(sp, 'to');
  const from = ctx.node;
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const dests = await sql<{ id: string; name: string }>`
      select id::text, name from inv.send_destinations(${from.id}::uuid)`.execute(tx);
    const chosen = to && isUuid(to) ? dests.rows.find((d) => d.id === to) : undefined;
    const items = chosen
      ? (
          await sql<SendItem>`
            select item_id::text, name, base_uom, on_hand::text, item_group,
                   to_on_hand::text, to_keep::text
              from inv.send_items(${from.id}::uuid, ${chosen.id}::uuid)`.execute(tx)
        ).rows
      : [];
    return { dests: dests.rows, chosen, items };
  });
  const back = `/stock/transfers?node=${from.id}`;
  const short = (name: string) => name.split(' – ').pop() ?? name;
  return (
    <div className="space-y-4">
      <Link
        href={data.chosen ? `/stock/transfers/send?node=${from.id}` : back}
        className="text-sm text-slate-600"
      >
        ← {data.chosen ? 'Choose another department' : 'Transfers'}
      </Link>
      {data.chosen ? (
        <>
          <h1 className="text-xl font-semibold">Send stock to {short(data.chosen.name)}</h1>
          <p className="text-sm text-slate-600">
            It leaves {short(from.name)} now. Whoever is on shift there gets a task to check it and
            confirm; their head is told.
          </p>
          <SendStockForm
            from={from.id}
            to={data.chosen.id}
            toName={short(data.chosen.name)}
            items={data.items}
            done={`${back}&tab=all`}
          />
        </>
      ) : (
        <>
          <h1 className="text-xl font-semibold">Send stock to</h1>
          {data.dests.length === 0 ? (
            <p className="text-slate-600">There is no department store to send to.</p>
          ) : (
            <ul className="space-y-2" data-testid="send-to">
              {data.dests.map((d) => (
                <li key={d.id}>
                  <Link
                    href={`/stock/transfers/send?node=${from.id}&to=${d.id}`}
                    className="flex min-h-12 items-center rounded-xl bg-white px-4 font-medium ring-1 ring-slate-200"
                  >
                    {short(d.name)}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
