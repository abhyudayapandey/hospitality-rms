import { formatMoney } from '@/lib/format';

export interface CheckedLine {
  name: string;
  /** how many were used */
  used: number;
  /** the guest's price; null for whoever sees no money (KI-09) */
  price: string | null;
}

/**
 * What a minibar check charges the guest (KI-09): the rupees for whoever sees prices, else the
 * items and how many ("Cola 300ml ×1, Lager 330ml ×2"). Free items (price 0) are never
 * charged. Null when there is nothing to charge.
 */
export function chargeWords(lines: readonly CheckedLine[]): string | null {
  const charged = lines.filter((l) => l.used > 0 && (l.price === null || Number(l.price) > 0));
  if (charged.length === 0) return null;
  if (charged.every((l) => l.price !== null)) {
    return formatMoney(charged.reduce((s, l) => s + l.used * Number(l.price), 0));
  }
  return charged.map((l) => `${l.name} ×${l.used}`).join(', ');
}
