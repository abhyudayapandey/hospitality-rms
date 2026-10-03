// Expiring and expired stock (INV-12, ADR 033): the Stock screen's two banners and the
// lists they open. Pure: inv.expiry_list decides which batches the person sees.

export interface ExpiryBatch {
  store_id: string;
  store: string;
  item_id: string;
  sku: string;
  name: string;
  unit: string;
  batch_no: string | null;
  expires_at: string;
  remaining: string;
  expired: boolean;
}

export type ExpiryShow = 'expiring' | 'expired';

export function expiryShow(s: string | undefined): ExpiryShow {
  return s === 'expired' ? 'expired' : 'expiring';
}

/** A store's batches: expiring soonest first; expired most recently expired first. */
export function splitExpiry(
  rows: readonly ExpiryBatch[],
  store: string,
): { expiring: ExpiryBatch[]; expired: ExpiryBatch[] } {
  const at = (b: ExpiryBatch) => new Date(b.expires_at).getTime();
  const here = rows.filter((b) => b.store_id === store);
  return {
    expiring: here.filter((b) => !b.expired).sort((a, b) => at(a) - at(b)),
    expired: here.filter((b) => b.expired).sort((a, b) => at(b) - at(a)),
  };
}

export const EXPIRY_TITLE: Record<ExpiryShow, string> = {
  expiring: 'Items expiring within 3 days',
  expired: 'Expired items',
};
