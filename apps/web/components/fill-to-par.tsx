'use client';

/**
 * "Fill all N short items" (ADR 054, 145): a real button above the list, saying what it does,
 * on the forms that ask for or send stock. Short is running low: under par, or 3 days or fewer
 * left (`inv.fill_qty`). Once used it clears what it put in.
 */
export function FillToPar({
  short,
  filled,
  onFill,
  onClear,
}: {
  /** how many items are running low */
  short: number;
  /** whether the amounts it puts in are there now */
  filled: boolean;
  onFill: () => void;
  onClear: () => void;
}) {
  if (short === 0) return null;
  return (
    <div className="space-y-1">
      <button
        type="button"
        data-testid="fill-to-keep"
        onClick={filled ? onClear : onFill}
        className="min-h-12 w-full rounded-lg border-2 border-brand-700 bg-white font-semibold text-brand-700"
      >
        {filled
          ? 'Clear the amounts'
          : short === 1
            ? 'Fill the 1 short item'
            : `Fill all ${short} short items`}
      </button>
      <p className="text-xs text-slate-500">
        {filled
          ? 'Change any amount before you send.'
          : 'Fills each item up to par. If it runs out in 3 days, it adds a week of use. You can change any amount.'}
      </p>
    </div>
  );
}
