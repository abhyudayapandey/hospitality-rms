import Link from 'next/link';
import { failure } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { sopPage, type SopPage } from '@/lib/training';
import { AckButton } from './ack-button';

// One SOP (ADR 095): its text, and "I've read this" where it is needed, once per version.
export default async function SopPageView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  let sop: SopPage | null;
  try {
    sop = await withUser(user.id, (tx) => sopPage(tx, id));
  } catch (err) {
    return <p className="rounded-xl bg-white p-6 text-slate-600">{failure(err).message}</p>;
  }
  if (!sop) return <p className="rounded-xl bg-white p-6 text-slate-600">That SOP is not there.</p>;
  return (
    <div className="space-y-4">
      <Link href="/me/sops" className="text-sm text-slate-600 underline">
        Back to my SOPs
      </Link>
      <div>
        <h1 className="text-xl font-semibold">{sop.title}</h1>
        <p className="text-sm text-slate-600">{sop.place}</p>
      </div>
      <article
        className="rounded-xl bg-white p-4 text-base leading-relaxed whitespace-pre-line ring-1 ring-slate-200"
        data-testid="sop-body"
      >
        {sop.body}
      </article>
      {sop.needs_ack &&
        (sop.acked_at ? (
          <p className="text-sm text-emerald-700" data-testid="sop-acked">
            You confirmed you read this, {formatWhen(sop.acked_at)}.
          </p>
        ) : (
          <AckButton sop={sop.id} />
        ))}
    </div>
  );
}
