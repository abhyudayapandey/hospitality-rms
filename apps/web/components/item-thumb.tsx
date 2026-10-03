import { Icon, type IconName } from './icon';

// A picture for each item (UX-6, ADR 034): its photo, or until it has one, a drawn icon
// for its kind: produce, drinks, linen, prep, meat and dairy; the rest a box. Never decoration alone: the
// name is always next to it.

const KINDS: readonly [RegExp, IconName][] = [
  [/produce|veg|fruit|herb|leaf/i, 'leaf'],
  [/liquor|spirit|wine|beer|mixer|bar|drink|juice|beverage/i, 'glass'],
  [/linen|amenit|room|housekeep/i, 'bed'],
  [/prep|sauce|batch|kitchen made/i, 'pot'],
  [/meat|seafood|fish|poultry|dairy/i, 'plate'],
];

export function itemIcon(category: string | null | undefined): IconName {
  return KINDS.find(([re]) => re.test(category ?? ''))?.[1] ?? 'box';
}

export function ItemThumb({
  category,
  src = null,
  size = 'size-11',
}: {
  category: string | null | undefined;
  /** the item's own photo (a short-lived URL), when it has one */
  src?: string | null | undefined;
  size?: string;
}) {
  if (src) {
    return (
      // a presigned S3 URL that changes on every page: next/image would cache it for nothing
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        className={`${size} shrink-0 rounded-lg object-cover ring-1 ring-slate-200`}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={`${size} flex shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700 ring-1 ring-brand-100`}
    >
      <Icon name={itemIcon(category)} className="size-6" />
    </span>
  );
}
