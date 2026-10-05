// The Stock screen as a store's hub (UX-4, ADR 035, 052): what needs doing first (stock on
// its way here, a count that is due), the list, then the jobs a store does. A department's
// store counts, records wastage and asks (for supplies, for stock); the Main Store sends
// stock out, counts and records wastage, and asking is a small link there (ADR 051). Pure, so
// it can be unit tested; access still comes from core.can through the pages and RPCs.

import type { IconName } from '@/components/icon';

export interface CountDue {
  due: boolean;
  /** whole days since the last submitted count; null when there has never been one */
  days: number | null;
}

const DAY = 86_400_000;

/** A count is due `everyDays` days after the last submitted one, or when there was none. */
export function countDue(
  lastSubmitted: Date | string | null,
  everyDays: number,
  now: Date = new Date(),
): CountDue {
  if (!lastSubmitted) return { due: true, days: null };
  const days = Math.floor((now.getTime() - new Date(lastSubmitted).getTime()) / DAY);
  return { due: days >= everyDays, days };
}

export function countDueText(c: CountDue): string {
  if (c.days === null) return 'Never counted here';
  return `Last counted ${c.days === 1 ? '1 day' : `${c.days} days`} ago`;
}

export interface HubAccess {
  /** STOCK_ADJUSTMENTS modify at a store they count (not a view-only place) */
  adjust: boolean;
  /** PURCHASE_ORDERS modify: asking for supplies */
  order: boolean;
  /** TRANSFERS modify at a place that holds stock: sending or asking for stock */
  request: boolean;
  /** the outlet's Main Store, which supplies the departments (ADR 049, 051) */
  mainStore: boolean;
}

export interface HubAction {
  key: 'send' | 'count' | 'wastage' | 'order' | 'request';
  label: string;
  href: string;
  icon: IconName;
}

/** The store's jobs: `main` as buttons, in the order a store works; `more` as small links. */
export function hubActions(a: HubAccess, q: string): { main: HubAction[]; more: HubAction[] } {
  const send = {
    key: 'send',
    label: 'Send stock',
    href: `/stock/transfers/send?${q}`,
    icon: 'truck',
    ok: a.request && a.mainStore,
  } as const;
  const count = {
    key: 'count',
    label: 'Count',
    href: `/stock/count?${q}`,
    icon: 'clipboard',
    ok: a.adjust,
  } as const;
  const wastage = {
    key: 'wastage',
    label: 'Record wastage',
    href: `/stock/wastage?${q}`,
    icon: 'trash',
    ok: a.adjust,
  } as const;
  const order = {
    key: 'order',
    label: 'Ask for supplies',
    href: `/stock/orders/new?${q}`,
    icon: 'cart',
    ok: a.order,
  } as const;
  const request = {
    key: 'request',
    label: 'Request stock',
    href: `/stock/transfers/new?${q}`,
    icon: 'box',
    ok: a.request,
  } as const;
  const pick = (xs: readonly (HubAction & { ok: boolean })[]) =>
    xs.filter((x) => x.ok).map(({ ok: _ok, ...x }) => x);
  return a.mainStore
    ? { main: pick([send, count, wastage]), more: pick([order, request]) }
    : { main: pick([count, wastage, order, request]), more: [] };
}
