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
