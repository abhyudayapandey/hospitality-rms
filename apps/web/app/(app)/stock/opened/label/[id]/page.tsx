import Link from 'next/link';
import { DAY_DOTS, failure, FOOD_TYPE_WORDS, STORAGE_WORDS } from '@outlet-ops/domain';
import { allergenText, FoodMark } from '@/components/food-mark';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { formatQty } from '@/lib/inventory';
import { packLabel, type PackLabel } from '@/lib/opened-packs';
import { PrintButton } from '../../../orders/[id]/print/print-button';

// The day-dot colours as the label stickers print them (ADR 093)
const DOT_CLASS: Record<string, string> = {
  black: 'bg-black',
  blue: 'bg-blue-600',
  yellow: 'bg-yellow-400',
  red: 'bg-red-600',
  green: 'bg-green-600',
  brown: 'bg-amber-900',
  orange: 'bg-orange-500',
};

// An opened pack's label (ADR 093): a day dot in the use-by day's colour, what it is, veg or
// non-veg, allergens, how to keep it, opened and use-by, and who opened it. Printed (or saved as
// PDF) and stuck on the pack.
export default async function PackLabelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  let label: PackLabel | null;
  try {
    label = await withUser(user.id, (tx) => packLabel(tx, id));
  } catch (err) {
    return (
      <p className="rounded-xl bg-white p-6 text-center text-slate-600 ring-1 ring-slate-200">
        {failure(err).message}
      </p>
    );
  }
  if (!label) {
    return (
      <p className="rounded-xl bg-white p-6 text-center text-slate-600 ring-1 ring-slate-200">
        That pack is not there.
      </p>
    );
  }
  const tz = label.tz;
  const when = (d: string) =>
    new Intl.DateTimeFormat('en-IN', {
      timeZone: tz,
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(d));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(
      new Date(label.use_by),
    ),
  );
  const dot = DAY_DOTS[Math.max(weekday, 0)]!;
  const allergens = allergenText(label.allergens);
  return (
    <div className="space-y-4">
      <Link href="/stock/opened" className="text-sm text-slate-600 underline print:hidden">
        Back to Opened packs
      </Link>
      <article
        className="mx-auto max-w-sm space-y-2 rounded-xl bg-white p-4 text-slate-900 ring-2 ring-slate-900"
        data-testid="pack-label"
      >
        <div className="flex items-start justify-between gap-3">
          <h1 className="flex items-center gap-2 text-xl font-bold">
            <FoodMark type={label.food_type} size={22} />
            {label.name}
          </h1>
          <span
            className={`size-12 shrink-0 rounded-full ring-2 ring-slate-900 ${DOT_CLASS[dot.colour]}`}
            role="img"
            aria-label={`${dot.day}: ${dot.colour}`}
            data-testid="day-dot"
          />
        </div>
        {label.food_type && label.food_type !== 'veg' && (
          <p className="text-sm font-semibold">{FOOD_TYPE_WORDS[label.food_type]}</p>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-slate-600">Opened</dt>
          <dd>{when(label.opened_at)}</dd>
          <dt className="text-slate-600">Use by</dt>
          <dd className="font-semibold" data-testid="label-use-by">
            {dot.day}, {when(label.use_by)}
          </dd>
          <dt className="text-slate-600">Quantity</dt>
          <dd>{formatQty(label.qty, label.unit)}</dd>
          <dt className="text-slate-600">Opened by</dt>
          <dd data-testid="label-opened-by">{label.opened_by ?? '–'}</dd>
          <dt className="text-slate-600">At</dt>
          <dd>{label.store}</dd>
        </dl>
        {label.storage && <p className="text-sm font-semibold">{STORAGE_WORDS[label.storage]}</p>}
        <p className="text-sm font-semibold" data-testid="label-allergens">
          {allergens ?? 'No allergens declared'}
        </p>
      </article>
      <div className="flex justify-center print:hidden">
        <PrintButton />
      </div>
    </div>
  );
}
