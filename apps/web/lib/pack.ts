import type { IconName } from '@/components/icon';

// What a count row is counted in (GM item 21, ADR 079): the pack beside the name, so a 750 ml
// bottle and a 180 ml nip of the same spirit are never mixed up. From the item's stock unit
// and its recipe-unit size (inv.item_unit: one 750 ml bottle = 750 ml).

export interface Pack {
  label: string;
  icon: IconName;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, ''));

/** "750 ml bottle", "180 ml nip", "1 L bottle", "5 kg bag", "pack of 12"; null if not known. */
export function packOf(
  unit: string,
  packUnit: string | null,
  packSize: string | number | null,
): Pack | null {
  const size = packSize === null ? NaN : Number(packSize);
  if (!packUnit || !Number.isFinite(size) || size <= 0) return null;
  const noun = unit.trim().toLowerCase();
  if (packUnit === 'ml') {
    const small = size <= 200;
    const what = noun && !/^(ml|l|litre|liter)s?$/.test(noun) ? noun : small ? 'nip' : 'bottle';
    const amount = size >= 1000 ? `${fmt(size / 1000)} L` : `${fmt(size)} ml`;
    return {
      label: `${amount} ${small && what === 'bottle' ? 'nip' : what}`,
      icon: small ? 'nip' : 'bottle',
    };
  }
  if (packUnit === 'g') {
    if (/^(g|kg|gram|grams|kilo|kilos)$/.test(noun) && size === (noun === 'kg' ? 1000 : 1)) {
      return null; // counted by weight: nothing to tell apart
    }
    const amount = size >= 1000 ? `${fmt(size / 1000)} kg` : `${fmt(size)} g`;
    return { label: `${amount} ${noun || 'pack'}`, icon: 'box' };
  }
  if (packUnit === 'each' && size > 1) {
    return { label: `${noun || 'pack'} of ${fmt(size)}`, icon: 'box' };
  }
  return null;
}

// Opened packs by whole packs (ADR 102): file 10's pack size (in the item's stock unit) and
// pack name. "1 tin = 400 ml", and a label's "2 tins · 800 ml".

const SMALL: Record<string, [string, number]> = { l: ['ml', 1000], kg: ['g', 1000] };

/** An amount in its stock unit, a litre under one in ml and a kilo under one in g: "400 ml". */
export function packAmount(qty: string | number, uom: string): string {
  const n = Number(qty);
  const small = SMALL[uom];
  if (small && Math.abs(n) < 1 && n !== 0) {
    return `${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n * small[1])} ${small[0]}`;
  }
  return `${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(n)} ${uom}`;
}

/** "1 tin", "2 tins", "3 boxes"; "pack" when it has no name. */
export function packCount(n: number, name: string | null | undefined): string {
  const one = (name ?? '').trim() || 'pack';
  if (n === 1) return `1 ${one}`;
  const many = /(s|x|ch|sh)$/i.test(one) ? `${one}es` : `${one}s`;
  return `${n} ${many}`;
}

/** How many whole packs a quantity is, or null when it is not a whole number of them. */
export function wholePacks(qty: string | number, size: string | number): number | null {
  const n = Number(qty) / Number(size);
  if (!Number.isFinite(n) || n <= 0) return null;
  const r = Math.round(n);
  return Math.abs(n - r) <= 1e-6 ? r : null;
}
