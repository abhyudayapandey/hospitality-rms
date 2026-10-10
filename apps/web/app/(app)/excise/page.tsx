import Link from 'next/link';
import { BackLink } from '@/components/back-link';
import { ItemThumb } from '@/components/item-thumb';
import { Empty } from '@/components/messages';
import { ViewTabs } from '@/components/view-tabs';
import { requireUser } from '@/lib/auth/server';
import { addDays, formatDay } from '@/lib/dates';
import { withUser } from '@/lib/db';
import {
  exciseMonth,
  excisePermits,
  exciseRegister,
  exciseStores,
  type ExciseLine,
} from '@/lib/excise';
import { isUuid, param, type SearchParams } from '@/lib/params';
import { formatQty } from '@/lib/qty';
import { PermitForm } from './permit-form';

// Excise (ADR 096): a store's daily bar register and its month (the FLR), from the stock
// ledger; and the transport permits for liquor that arrived.
export default async function ExcisePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const user = await requireUser();
  const stores = await withUser(user.id, (tx) => exciseStores(tx));
  const asked = param(sp, 'node');
  const store = stores.find((s) => isUuid(asked) && s.store_id === asked) ?? stores[0];
  if (!store) {
    return (
      <div className="space-y-4">
        <BackLink />
        <h1 className="text-xl font-semibold">Excise</h1>
        <Empty>You don&apos;t keep an excise register anywhere.</Empty>
      </div>
    );
  }
  const view = (['day', 'month', 'permits'] as const).find((v) => v === param(sp, 'view')) ?? 'day';
  const askedDay = param(sp, 'day');
  const day =
    /^\d{4}-\d{2}-\d{2}$/.test(askedDay ?? '') && askedDay <= store.today ? askedDay : store.today;
  const month = `${day.slice(0, 7)}-01`;
  const data = await withUser(user.id, async (tx) => ({
    lines:
      view === 'day'
        ? await exciseRegister(tx, store.store_id, day)
        : view === 'month'
          ? await exciseMonth(tx, store.store_id, month)
          : [],
    permits: view === 'permits' ? await excisePermits(tx, store.store_id) : [],
  }));
  const href = (v: string, d = day) => `/excise?node=${store.store_id}&view=${v}&day=${d}`;
  return (
    <div className="space-y-4">
      <BackLink />
      <div>
        <h1 className="text-xl font-semibold">Excise</h1>
        <p className="text-sm text-slate-600">{store.name}</p>
      </div>
      {stores.length > 1 && (
        <nav aria-label="Store" className="flex flex-wrap gap-2">
          {stores.map((s) => (
            <Link
              key={s.store_id}
              href={`/excise?node=${s.store_id}&view=${view}`}
              aria-current={s.store_id === store.store_id ? 'page' : undefined}
              className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-medium ring-1 ${
                s.store_id === store.store_id
                  ? 'bg-brand-700 text-white ring-brand-700'
                  : 'bg-white text-slate-700 ring-slate-300'
              }`}
            >
              {s.name}
            </Link>
          ))}
        </nav>
      )}
      <ViewTabs
        label="Excise"
        current={view}
        tabs={[
          { key: 'day', label: 'Day', href: href('day') },
          { key: 'month', label: 'Month (FLR)', href: href('month') },
          { key: 'permits', label: 'Permits', href: href('permits') },
        ]}
      />
      {view === 'day' && (
        <nav aria-label="Day" className="flex items-center justify-between text-sm">
          <Link href={href('day', addDays(day, -1))} className="min-h-11 underline">
            ← Day before
          </Link>
          <span className="font-medium">{formatDay(day)}</span>
          {day < store.today ? (
            <Link href={href('day', addDays(day, 1))} className="min-h-11 underline">
              Day after →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
      {view === 'month' && (
        <p className="text-sm font-medium">
          {new Date(`${month}T00:00:00`).toLocaleDateString('en-IN', {
            month: 'long',
            year: 'numeric',
          })}
        </p>
      )}
      {view !== 'permits' && <Register lines={data.lines} />}
      {view === 'permits' && (
        <>
          {data.permits.length === 0 ? (
            <Empty>No permits in the last three months.</Empty>
          ) : (
            <ul
              className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
              data-testid="permits"
            >
              {data.permits.map((p) => (
                <li key={p.id} className="px-4 py-3 text-sm" data-testid="permit">
                  <span className="block font-medium">{p.permit_no}</span>
                  <span className="block text-xs text-slate-500">
                    {formatDay(p.received_on)}
                    {p.added_by && ` · ${p.added_by}`}
                    {p.note && ` · ${p.note}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {store.can_edit && <PermitForm store={store.store_id} today={store.today} />}
        </>
      )}
    </div>
  );
}

/** Opening, in, out and closing for each item; out is what was sold, sent, used or wasted. */
function Register({ lines }: { lines: ExciseLine[] }) {
  if (lines.length === 0) return <Empty>No excise items are kept here.</Empty>;
  return (
    <ul
      className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
      data-testid="excise-register"
    >
      {lines.map((l) => {
        const out = Number(l.sold) + Number(l.sent) + Number(l.used) + Number(l.wasted);
        return (
          <li key={l.item_id} className="space-y-1 px-4 py-3 text-sm" data-testid="excise-line">
            <span className="flex items-center gap-3">
              <ItemThumb name={l.item} fallback="spirits" size="size-10" />
              <span className="min-w-0 font-medium">{l.item}</span>
            </span>
            <span className="grid grid-cols-4 gap-2 text-xs tabular-nums text-slate-600">
              <span>
                Opening
                <span className="block text-sm text-slate-900">{formatQty(l.opening, l.unit)}</span>
              </span>
              <span>
                In
                <span className="block text-sm text-slate-900">
                  {formatQty(l.received, l.unit)}
                </span>
              </span>
              <span>
                Out
                <span className="block text-sm text-slate-900" data-testid="excise-out">
                  {formatQty(out, l.unit)}
                </span>
              </span>
              <span>
                Closing
                <span
                  className="block text-sm font-semibold text-slate-900"
                  data-testid="excise-closing"
                >
                  {formatQty(l.closing, l.unit)}
                </span>
              </span>
            </span>
            {Number(l.adjusted) !== 0 && (
              <span className="block text-xs text-amber-800">
                Count correction {formatQty(l.adjusted, l.unit)}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
