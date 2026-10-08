import Link from 'next/link';
import { failure, FOOD_TYPE_WORDS } from '@outlet-ops/domain';
import { allergenText, FoodMark } from '@/components/food-mark';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { formatQty } from '@/lib/inventory';
import { batchLabel, type BatchLabel } from '@/lib/production';
import { PrintButton } from '../../../orders/[id]/print/print-button';

// A batch's label (ADR 076), as FSSAI asks of food made in the kitchen: what it is, veg or
// non-veg, its batch number, when it was made and its use-by, allergens, who made it and how
// much. Printed (or saved as PDF) and stuck on the container. For whoever sees the store's
// batches, and whoever made it.
export default async function BatchLabelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  let label: BatchLabel | null;
  try {
    label = await withUser(user.id, (tx) => batchLabel(tx, id));
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
        That batch is not there.
      </p>
    );
  }
  const when = (d: Date) =>
    new Intl.DateTimeFormat('en-IN', {
      timeZone: label.tz,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(d));
  const allergens = allergenText(label.allergens);
  return (
    <div className="space-y-4">
      <Link href="/stock/production" className="text-sm text-slate-600 underline print:hidden">
        Back to Make
      </Link>
      <article
        className="mx-auto max-w-sm space-y-2 rounded-xl bg-white p-4 text-slate-900 ring-2 ring-slate-900"
        data-testid="batch-label"
      >
        <h1 className="flex items-center gap-2 text-xl font-bold">
          <FoodMark type={label.food_type} size={22} />
          {label.name}
        </h1>
        {label.food_type && label.food_type !== 'veg' && (
          <p className="text-sm font-semibold">{FOOD_TYPE_WORDS[label.food_type]}</p>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-slate-600">Batch no.</dt>
          <dd className="font-mono font-semibold" data-testid="label-batch">
            {label.batch_no ?? '–'}
          </dd>
          <dt className="text-slate-600">Made</dt>
          <dd>{when(label.made_at)}</dd>
          <dt className="text-slate-600">Use by</dt>
          <dd className="font-semibold">{label.expires_at ? when(label.expires_at) : '–'}</dd>
          <dt className="text-slate-600">Quantity</dt>
          <dd>
            {formatQty(label.qty, label.unit)}
            {label.batch_portions && ` · about ${Number(label.batch_portions)} portions`}
          </dd>
          <dt className="text-slate-600">Made by</dt>
          <dd data-testid="label-made-by">{label.made_by ?? '–'}</dd>
          <dt className="text-slate-600">Made at</dt>
          <dd>{label.store}</dd>
        </dl>
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
