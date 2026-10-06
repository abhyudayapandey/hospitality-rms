'use client';

/**
 * "Fill all N short items up to par" (ADR 054): a real button above the list, saying what it
 * does, on the forms that ask for or send stock. Once used it clears what it put in.
 */
export function FillToPar({
  short,
  filled,
  onFill,
  onClear,
}: {
  /** how many items are below par */
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
            ? 'Fill the 1 short item up to par'
            : `Fill all ${short} short items up to par`}
      </button>
      <p className="text-xs text-slate-500">
        {filled
          ? 'Change any amount before you send.'
          : 'Puts in what each item needs to reach its par. You can change any amount.'}
      </p>
    </div>
  );
}
