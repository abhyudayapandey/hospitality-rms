import Link from 'next/link';
import { Icon, type IconName } from '@/components/icon';
import { ItemThumb, ItemThumbs } from '@/components/item-thumb';
import { Empty } from '@/components/messages';
import { CsvLink, NoReport, PeriodPicker, ReportHeader } from '@/components/report-view';
import { ShowMore } from '@/components/show-more';
import { ViewTabs } from '@/components/view-tabs';
import { requireUser } from '@/lib/auth/server';
import { formatDay } from '@/lib/dates';
import { withUser } from '@/lib/db';
import { formatMoney } from '@/lib/format';
import { formatQty } from '@/lib/inventory';
import { param, type SearchParams } from '@/lib/params';
import {
  reportPeriod,
  reportPlace,
  reportToday,
  stockMovements,
  type Movement,
} from '@/lib/report-data';

// Stock movements (ADR 122): what was ordered from suppliers, received and sent between
// stores at a store, or all of an outlet's stores ("All stores" first), for today, a week, a
// month or any days. A figure at the top is its tab's list added up; each line opens to its
// items. For the GM, the purchase manager and whoever reads the stores' bills.

type Tab = 'all' | 'ordered' | 'received' | 'transfer';
const TABS: readonly { key: Tab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'ordered', label: 'Ordered' },
  { key: 'received', label: 'Received' },
  { key: 'transfer', label: 'Transfers' },
];
const PAGE = 30;

const STATUS: Record<string, string> = {
  ordered: 'not received yet',
  'part received': 'part received',
  received: 'received',
  closed: 'closed',
  'on the way': 'on the way',
};

function title(m: Movement): string {
  if (m.kind === 'ordered') return `Ordered from ${m.other ?? 'a supplier'}`;
  if (m.kind === 'received') return `Received from ${m.other ?? 'a supplier'}`;
  if (m.direction === 'within') return `${m.store} → ${m.other}`;
  return m.direction === 'out' ? `Sent to ${m.other}` : `From ${m.other}`;
}

const ICONS: Record<Movement['kind'], IconName> = {
  ordered: 'cart',
  received: 'truck',
  transfer: 'swap',
};

export default async function Movements({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const sp = await searchParams;
  const data = await withUser(user.id, async (tx) => {
    const { places, place } = await reportPlace(tx, 'movements', searchParams);
    if (!place) return null;
    const range = await reportPeriod(
      Promise.resolve({ period: 'today', ...sp }),
      await reportToday(tx, place.id),
    );
    return { places, place, range, rows: await stockMovements(tx, place.id, range.from, range.to) };
  });
  if (!data) return <NoReport>You don&apos;t have access to this report.</NoReport>;
  const { places, place, range, rows } = data;
  const asked = param(sp, 'tab');
  const tab: Tab = TABS.some((t) => t.key === asked) ? (asked as Tab) : 'all';
  const shown = Math.max(PAGE, Number(param(sp, 'show')) || PAGE);
  const of = (k: Tab) => (k === 'all' ? rows : rows.filter((r) => r.kind === k));
  const list = of(tab);
  const total = (k: Tab) => of(k).reduce((t, r) => t + Number(r.value), 0);
  const allStores = places.length > 1 && place.name.endsWith('All stores');
  const q = (extra: Record<string, string | number>) =>
    `/reports/movements?${new URLSearchParams({
      node: place.id,
      period: range.period,
      from: range.from,
      to: range.to,
      ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])),
    })}`;

  return (
    <div className="space-y-4">
      <ReportHeader
        report="movements"
        switcher={{ screen: 'movements', places, current: place.id }}
      />
      <PeriodPicker
        action="/reports/movements"
        node={place.id}
        period={range.period}
        from={range.from}
        to={range.to}
        today
      />

      <ul className="grid grid-cols-3 gap-2" data-testid="movement-totals">
        {TABS.filter((t) => t.key !== 'all').map((t) => (
          <li key={t.key}>
            <Link
              href={q({ tab: t.key })}
              className="block rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200"
              data-testid={`total-${t.key}`}
            >
              <span className="block text-xs text-slate-600">{t.label}</span>
              <span className="block font-semibold tabular-nums">{formatMoney(total(t.key))}</span>
            </Link>
          </li>
        ))}
      </ul>

      <ViewTabs
        label="Movements"
        current={tab}
        tabs={TABS.map((t) => ({
          key: t.key,
          label: t.label,
          count: of(t.key).length,
          href: q({ tab: t.key }),
        }))}
      />

      {list.length === 0 ? (
        <Empty>
          Nothing{' '}
          {tab === 'all'
            ? 'ordered, received or moved'
            : TABS.find((t) => t.key === tab)!.label.toLowerCase()}{' '}
          {range.from === range.to ? `on ${formatDay(range.from)}` : 'in these days'}.
        </Empty>
      ) : (
        <ul className="space-y-2" data-testid="movements">
          {list.slice(0, shown).map((m) => (
            <li
              key={`${m.kind}-${m.id}`}
              className="rounded-xl bg-white ring-1 ring-slate-200"
              data-testid="movement"
              data-kind={m.kind}
            >
              <details>
                <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 px-4 py-3">
                  <Icon name={ICONS[m.kind]} className="size-6 shrink-0 text-brand-700" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{title(m)}</span>
                    <span className="block text-xs text-slate-500">
                      {formatDay(m.day)}
                      {allStores && m.direction !== 'within' && ` · ${m.store}`}
                      {m.by_name && ` · ${m.by_name}`}
                      {m.status && ` · ${STATUS[m.status] ?? m.status}`}
                    </span>
                    <span className="mt-1 flex">
                      <ItemThumbs names={m.lines.map((l) => l.item).join(', ')} />
                    </span>
                  </span>
                  <span className="shrink-0 text-right font-semibold tabular-nums">
                    {formatMoney(m.value)}
                    <span className="block text-xs font-normal text-slate-500">
                      {m.lines.length} {m.lines.length === 1 ? 'item' : 'items'}
                    </span>
                  </span>
                </summary>
                <ul className="divide-y divide-slate-100 border-t border-slate-100">
                  {m.lines.map((l, i) => (
                    <li key={i} className="flex items-center gap-3 px-4 py-2 text-sm">
                      <ItemThumb name={l.item} size="size-8" />
                      <span className="min-w-0 flex-1">
                        {l.item}
                        <span className="block text-xs text-slate-500">
                          {formatQty(l.qty, l.unit)}
                          {m.kind === 'transfer' &&
                            (l.received == null
                              ? ' · not received yet'
                              : ` · ${formatQty(l.received, l.unit)} received`)}
                        </span>
                      </span>
                      <span className="shrink-0 tabular-nums">{formatMoney(l.value)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          ))}
        </ul>
      )}
      {list.length > shown && <ShowMore href={q({ tab, show: shown + PAGE })} />}
      <CsvLink report="movements" node={place.id} period={range} />
    </div>
  );
}
