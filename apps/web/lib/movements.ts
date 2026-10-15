// A ledger movement in the person's words (ADR 034, 149): never its code.
const MOVEMENT: Record<string, string> = {
  receipt: 'Received',
  consumption: 'Used',
  wastage: 'Wastage',
  transfer_out: 'Sent',
  transfer_in: 'Transfer in',
  count_adjust: 'Count adjustment',
  production_in: 'Made',
  production_out: 'Used to make',
  sales_depletion: 'Sold',
};

function words(code: string): string {
  const s = code.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function movementLabel(type: string, reason: string | null): string {
  const r = reason && reason !== 'opening balance' ? ` · ${reason.replace(/_/g, ' ')}` : '';
  return `${MOVEMENT[type] ?? words(type)}${r}`;
}
