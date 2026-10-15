// What can break (ADR 153): durable things and anything counted in pieces or bottles, never what
// is weighed or poured (ice, salt, coffee beans). With none of those, every item is offered.
const MEASURED = new Set(['kg', 'g', 'l', 'ml', 'ltr', 'litre', 'liter', 'gm']);

export function breakable<T extends { durable: boolean; unit: string }>(items: readonly T[]): T[] {
  const can = items.filter((i) => i.durable || !MEASURED.has(i.unit.trim().toLowerCase()));
  return can.length > 0 ? can : [...items];
}
