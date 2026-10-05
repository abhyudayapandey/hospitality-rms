import Link from 'next/link';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatMoney, formatWhen } from '@/lib/format';
import { photosEnabled, presignPhotoView } from '@/lib/photos';
import { ArchiveBill } from './archive-bill';

// One vendor bill with its photos and PDFs (ADR 050). inv.bill_detail returns it only to whoever
// may see it; the files are opened through 5-minute links.

interface Bill {
  id: string;
  store_id: string;
  store: string;
  kind: 'goods' | 'service';
  po_id: string | null;
  supplier: string | null;
  bill_no: string | null;
  bill_date: Date;
  amount: string;
  currency: string;
  description: string | null;
  files: string[];
  added_by: string | null;
  added_at: Date;
  archived_at: Date | null;
  archive_reason: string | null;
  can_archive: boolean;
}

export default async function BillPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const bill = await withUser(user.id, async (tx) => {
    const r = await sql<Bill>`select * from inv.bill_detail(${id}::uuid)`.execute(tx);
    return r.rows[0];
  });
  if (!bill) return <Empty>Bill not found.</Empty>;
  const files = photosEnabled()
    ? await Promise.all(
        bill.files.map(async (key, i) => ({
          url: await presignPhotoView(key),
          pdf: key.endsWith('.pdf'),
          label: `Page ${i + 1}`,
        })),
      )
    : [];
  const date = new Date(bill.bill_date).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return (
    <div className="space-y-4">
      <Link href={`/stock/bills?node=${bill.store_id}`} className="text-sm text-slate-600">
        ← Bills
      </Link>
      <div className="rounded-xl bg-white p-4 ring-1 ring-slate-200" data-testid="bill">
        <div className="flex items-baseline justify-between gap-2">
          <h1 className="text-lg font-semibold">{bill.supplier}</h1>
          <span className="text-lg font-semibold tabular-nums">
            {formatMoney(bill.amount, bill.currency)}
          </span>
        </div>
        <p className="text-sm text-slate-600">
          {bill.store} · {date}
          {bill.bill_no && ` · No. ${bill.bill_no}`}
        </p>
        {bill.description && <p className="mt-1 text-sm">{bill.description}</p>}
        {bill.po_id && (
          <Link
            href={`/stock/orders/${bill.po_id}?node=${bill.store_id}`}
            className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-brand-700"
          >
            Open the order
          </Link>
        )}
        <p className="mt-1 text-xs text-slate-500">
          Added by {bill.added_by ?? 'someone'}, {formatWhen(bill.added_at)}
        </p>
        {bill.archived_at && (
          <p className="mt-2 rounded-lg bg-slate-100 p-2 text-sm text-slate-700">
            Archived: {bill.archive_reason}
          </p>
        )}
      </div>
      {files.length > 0 && (
        <ul className="grid grid-cols-2 gap-2" data-testid="bill-pages">
          {files.map((f) => (
            <li key={f.label}>
              <a
                href={f.url}
                target="_blank"
                rel="noreferrer"
                className="flex min-h-24 flex-col items-center justify-center gap-1 overflow-hidden rounded-xl bg-white p-2 text-sm font-medium ring-1 ring-slate-200"
              >
                {f.pdf ? (
                  <span className="text-2xl" aria-hidden>
                    PDF
                  </span>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element -- short-lived S3 link
                  <img src={f.url} alt={f.label} className="max-h-40 rounded-lg" />
                )}
                {f.label}
              </a>
            </li>
          ))}
        </ul>
      )}
      {bill.can_archive && (
        <ArchiveBill bill={bill.id} back={`/stock/bills?node=${bill.store_id}`} />
      )}
    </div>
  );
}
