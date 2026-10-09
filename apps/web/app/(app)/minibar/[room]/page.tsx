import { BackLink } from '@/components/back-link';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { formatMoney, formatWhen } from '@/lib/format';
import { minibarHistory, minibarRoom, usedWords } from '@/lib/minibar';
import { isUuid } from '@/lib/params';
import { CheckForm } from './check-form';

// Check one room's minibar (ADR 072): count what is left of each item; what is missing is
// charged; the refill and the bill are To do items (ADR 081). Then the room's recent checks.
export default async function MinibarRoomPage({ params }: { params: Promise<{ room: string }> }) {
  const { room } = await params;
  const user = await requireUser();
  if (!isUuid(room)) return <Empty>We couldn&apos;t find that room.</Empty>;
  const data = await withUser(user.id, async (tx) => {
    try {
      return { items: await minibarRoom(tx, room), history: await minibarHistory(tx, room) };
    } catch {
      return null;
    }
  });
  if (!data) {
    return (
      <div className="space-y-4">
        <BackLink />
        <Empty>You don&apos;t look after this room&apos;s minibar.</Empty>
      </div>
    );
  }
  const { items, history } = data;
  const first = items[0];
  return (
    <div className="space-y-4">
      <BackLink />
      <div>
        <h1 className="text-xl font-semibold">Room {first?.number ?? ''} minibar</h1>
        {first && (
          <p className="text-sm text-slate-600">
            Count what is left. Whatever is missing is charged to the guest; refilling it from{' '}
            {first.store} and adding it to the bill go on the To do list.
          </p>
        )}
      </div>
      {!first ? (
        <Empty>This room has no minibar.</Empty>
      ) : first.can_check ? (
        <CheckForm
          room={room}
          items={items.map((i) => ({
            id: i.item_id,
            name: i.item,
            unit: i.unit,
            par: Number(i.par),
            price: i.price,
            inStore: Number(i.in_store),
          }))}
        />
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
          {items.map((i) => (
            <li key={i.item_id} className="flex justify-between px-3 py-2 text-sm">
              <span>{i.item}</span>
              <span className="text-slate-500">
                par {Number(i.par)} · {formatMoney(i.price)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <section aria-label="Recent checks" className="space-y-2">
        <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
          Recent checks
        </h2>
        {history.length === 0 ? (
          <p className="text-sm text-slate-500">Not checked yet.</p>
        ) : (
          <ul className="space-y-2" data-testid="minibar-history">
            {history.map((h) => (
              <li key={h.id} className="rounded-xl bg-white p-3 text-sm ring-1 ring-slate-200">
                <div className="flex justify-between gap-2">
                  <span>
                    {formatWhen(h.checked_at)}
                    {h.checked_by && ` · ${h.checked_by}`}
                  </span>
                  <span className="font-semibold">
                    {Number(h.charge) > 0 ? formatMoney(h.charge) : 'Nothing used'}
                  </span>
                </div>
                {h.used.length > 0 && <p className="text-slate-600">{usedWords(h.used)}</p>}
                <p className="text-xs text-slate-500">
                  {Number(h.charge) === 0
                    ? ''
                    : h.charged_at
                      ? `On the bill${h.charged_by ? ` (${h.charged_by})` : ''}`
                      : 'Still to add to the bill'}
                  {h.short && ' · the store was short, so it is not full'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
