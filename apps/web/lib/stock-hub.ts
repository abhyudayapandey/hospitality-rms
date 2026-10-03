// The Stock screen as a store's hub (UX-4, ADR 035): what needs doing first (running low,
// expiring, stock on its way here, a count that is due), then four buttons for the jobs a
// store does (Count, Record wastage, Order, Request stock), then the list. Pure, so it can
// be unit tested; access still comes from core.can through the pages and RPCs.

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
  /** PURCHASE_ORDERS modify */
  order: boolean;
  /** TRANSFERS modify at a place that holds stock */
  request: boolean;
}

export interface HubAction {
  key: 'count' | 'wastage' | 'order' | 'request';
  label: string;
  href: string;
  icon: IconName;
}

/** The buttons the person may use here, in the order a store works. */
export function hubActions(a: HubAccess, q: string): HubAction[] {
  const all: (HubAction & { ok: boolean })[] = [
    { key: 'count', label: 'Count', href: `/stock/count?${q}`, icon: 'clipboard', ok: a.adjust },
    {
      key: 'wastage',
      label: 'Record wastage',
      href: `/stock/wastage?${q}`,
      icon: 'trash',
      ok: a.adjust,
    },
    { key: 'order', label: 'Order', href: `/stock/orders/new?${q}`, icon: 'cart', ok: a.order },
    {
      key: 'request',
      label: 'Request stock',
      href: `/stock/transfers/new?${q}`,
      icon: 'truck',
      ok: a.request,
    },
  ];
  return all.filter((x) => x.ok).map(({ ok: _ok, ...x }) => x);
}
