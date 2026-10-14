import { failure } from '@outlet-ops/domain';
import { BackLink } from '@/components/back-link';
import { ItemThumb } from '@/components/item-thumb';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatQty } from '@/lib/qty';
import { RequestNow, RequestStory } from '../../transfers/[id]/request-story';
import { CollectButton } from './collect-button';
import { HeadActions } from './head-actions';

// One ask (ADR 115): where it is now first, what was asked, then for the department head what
// to do with it (give it, ask for it, or say no), and its story.
export default async function AskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  let data;
  try {
    data = await withUser(user.id, async (tx) => {
      const a = (
        await sql<{
          store: string;
          asked_by: string;
          note: string | null;
          status: string;
          may_act: boolean;
          lines: {
            item_id: string;
            name: string;
            base_uom: string;
            qty: number;
            at_store: number;
            /** the store's par (ADR 141) */
            par: number | null;
          }[];
        }>`select store, asked_by, note, status, may_act, lines
             from inv.staff_ask_detail(${id}::uuid)`.execute(tx)
      ).rows[0];
      const now = (
        await sql<{ stage: string; words: string }>`
          select stage, words from inv.staff_ask_now(${id}::uuid)`.execute(tx)
      ).rows[0];
      const story = (
        await sql<{ at: Date; words: string }>`
          select at, words from inv.staff_ask_story(${id}::uuid)`.execute(tx)
      ).rows;
      // whoever asked and was given it: take it to the department, then say so (ADR 142)
      const collect = (
        await sql<{ department: string }>`
          select department from inv.my_collect(${id}::uuid)`.execute(tx)
      ).rows[0];
      return { a, now, story, collect };
    });
  } catch (err) {
    return (
      <p className="rounded-xl bg-white p-6 text-center text-slate-600 ring-1 ring-slate-200">
        {failure(err).message}
      </p>
    );
  }
  const { a, now, story, collect } = data;
  if (!a) return null;
  const short = a.lines.some((l) => l.at_store < l.qty);
  return (
    <div className="space-y-4">
      <BackLink fallback="/requests" />
      <header>
        <p className="text-xs font-medium text-slate-500">
          {a.asked_by} asked the {a.store}
        </p>
        <h1 className="text-lg font-semibold">{a.note ?? 'Asked for'}</h1>
      </header>
      {now && <RequestNow stage={now.stage} words={now.words} />}
      <ul
        className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
        data-testid="ask-lines"
      >
        {a.lines.map((l) => (
          <li key={l.item_id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <span className="flex min-w-0 items-center gap-3">
              <ItemThumb name={l.name} size="size-10" />
              <span className="font-medium">{l.name}</span>
            </span>
            <span className="text-right tabular-nums">
              ×{formatQty(String(l.qty), l.base_uom)}
              {a.may_act && (
                <span
                  className={`block text-xs ${l.at_store < l.qty ? 'text-amber-800' : 'text-slate-500'}`}
                >
                  store has {formatQty(String(l.at_store), l.base_uom)}
                  {Number(l.par) > 0 && ` · par ${formatQty(String(l.par), l.base_uom)}`}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {a.may_act && (
        <HeadActions ask={id} status={a.status} short={short} arrived={now?.stage === 'arrived'} />
      )}
      {collect && <CollectButton ask={id} department={collect.department} />}
      <RequestStory story={story} />
    </div>
  );
}
