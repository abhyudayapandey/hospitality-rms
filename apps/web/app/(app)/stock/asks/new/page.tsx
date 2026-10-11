import { BackLink } from '@/components/back-link';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { isUuid } from '@/lib/inventory';
import { AskForm, type AskStoreItem } from './ask-form';

// Ask for something (ADR 115): a frontline person asks the store their team uses; it goes to
// their department head, and they follow it under What I asked for.
export default async function NewAskPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const stores = (
      await sql<{ id: string; name: string }>`
        select id::text, name from inv.my_ask_stores()`.execute(tx)
    ).rows;
    const asked = typeof sp['store'] === 'string' && isUuid(sp['store']) ? sp['store'] : null;
    const store = stores.find((s) => s.id === asked) ?? stores[0] ?? null;
    const items = store
      ? (
          await sql<AskStoreItem>`
            select item_id::text, name, base_uom, on_hand::text
              from inv.ask_store_items(${store.id}::uuid)`.execute(tx)
        ).rows
      : [];
    return { stores, store, items };
  });
  return (
    <div className="space-y-4">
      <BackLink fallback="/stock/asks" />
      <h1 className="text-xl font-semibold">Ask for something</h1>
      {!data.store ? (
        <Empty icon="box">Your team has no store to ask.</Empty>
      ) : (
        <AskForm stores={data.stores} store={data.store} items={data.items} />
      )}
    </div>
  );
}
