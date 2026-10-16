import { formatNumber, formatQty } from './qty';

// What a request's approver and sender decide on (ADR 141): for each line, what the giving
// store has, and what the asking store already has against its par. Read through
// inv.request_levels, which checks who may follow the request.

export interface RequestLevel {
  item_id: string;
  name: string;
  base_uom: string;
  asked: string;
  from_name: string;
  from_on_hand: string;
  to_name: string;
  to_on_hand: string;
  to_par: string | null;
}

/** "Main Store has 34 bottles · Bar Store has 19.57 of 24 bottles"; "73 of 80 each". */
export function levelsText(l: RequestLevel): string {
  const here =
    Number(l.to_par) > 0
      ? `${formatNumber(l.to_on_hand, l.base_uom)} of ${formatQty(l.to_par!, l.base_uom)}`
      : formatQty(l.to_on_hand, l.base_uom);
  return `${l.from_name} has ${formatQty(l.from_on_hand, l.base_uom)} · ${l.to_name} has ${here}`;
}

/** Quantities in words at most 2 decimals, as everywhere: "usual 12.107 bottle" -> "12.11". */
export function twoDecimals(text: string): string {
  return text.replace(/\d+\.\d{3,}/g, (m) => String(Math.round(Number(m) * 100) / 100));
}
