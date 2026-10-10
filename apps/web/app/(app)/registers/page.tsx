import Link from 'next/link';
import { registerDef, REGISTERS } from '@outlet-ops/domain';
import { BackLink } from '@/components/back-link';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { isUuid, param, type SearchParams } from '@/lib/params';
import { registerEntries, registerPlaces } from '@/lib/registers';
import { loadShell } from '@/lib/shell';
import { CloseEntry } from './close-entry';
import { EntryForm } from './entry-form';

// Registers (ADR 090): a place's registers as tabs; each lists what is still open, then the
// last month's closed entries, and below them the form for a new one.
export default async function RegistersPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const user = await requireUser();
  const shell = await loadShell();
  const places = await withUser(user.id, (tx) => registerPlaces(tx));
  const asked = param(sp, 'place');
  const place =
    places.find((p) => isUuid(asked) && p.place_id === asked) ??
    places.find((p) => p.place_id === shell.home?.id) ??
    places[0];
  if (!place) {
    return (
      <div className="space-y-4">
        <BackLink />
        <h1 className="text-xl font-semibold">Registers</h1>
        <Empty>You don&apos;t keep any registers.</Empty>
      </div>
    );
  }
  const order = REGISTERS.map((r) => r.code as string);
  const mine = [...place.registers].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const askedReg = param(sp, 'register');
  const register = askedReg && mine.includes(askedReg) ? askedReg : mine[0]!;
  const def = registerDef(register)!;
  const entries = await withUser(user.id, (tx) => registerEntries(tx, place.place_id, register));
  const href = (r: string, p = place.place_id) => `/registers?place=${p}&register=${r}`;
  return (
    <div className="space-y-4">
      <BackLink />
      <div>
        <h1 className="text-xl font-semibold">Registers</h1>
        <p className="text-sm text-slate-600">{place.place}</p>
      </div>
      {places.length > 1 && (
        <nav aria-label="Where" className="flex flex-wrap gap-2">
          {places.map((p) => (
            <Link
              key={p.place_id}
              href={`/registers?place=${p.place_id}`}
              aria-current={p.place_id === place.place_id ? 'page' : undefined}
              className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-medium ring-1 ${
                p.place_id === place.place_id
                  ? 'bg-brand-700 text-white ring-brand-700'
                  : 'bg-white text-slate-700 ring-slate-300'
              }`}
            >
              {p.kind === 'outlet' ? `${p.place} (whole outlet)` : p.place}
            </Link>
          ))}
        </nav>
      )}
      <nav aria-label="Register" className="flex flex-wrap gap-2" data-testid="register-tabs">
        {mine.map((r) => (
          <Link
            key={r}
            href={href(r)}
            aria-current={r === register ? 'page' : undefined}
            className={`inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium ring-1 ${
              r === register
                ? 'bg-brand-700 text-white ring-brand-700'
                : 'bg-white text-slate-700 ring-slate-300'
            }`}
          >
            {registerDef(r)?.name}
          </Link>
        ))}
      </nav>
      <p className="text-sm text-slate-600">{def.what}</p>
      {entries.length === 0 ? (
        <Empty>Nothing in this register this month.</Empty>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
          {entries.map((e) => (
            <li
              key={e.id}
              className="space-y-1 px-4 py-3"
              data-testid="register-entry"
              data-status={e.status}
            >
              <p className="font-medium">{e.fields[def.fields[0]!.key]}</p>
              <dl className="text-sm text-slate-700">
                {def.fields.slice(1).map(
                  (f) =>
                    e.fields[f.key] && (
                      <div key={f.key}>
                        <dt className="inline text-slate-500">{f.label}: </dt>
                        <dd className="inline">{e.fields[f.key]}</dd>
                      </div>
                    ),
                )}
              </dl>
              <p className="text-xs text-slate-500">
                {e.written_by}, {formatWhen(e.written_at)}
                {e.status === 'closed' &&
                  def.close &&
                  ` · ${e.outcome ?? def.close.label}${e.close_note ? ` (${e.close_note})` : ''}, ${e.closed_by} ${formatWhen(e.closed_at!)}`}
              </p>
              {e.can_close && <CloseEntry entry={e.id} register={register} />}
            </li>
          ))}
        </ul>
      )}
      {place.can_write.includes(register) && (
        <EntryForm place={place.place_id} register={register} />
      )}
    </div>
  );
}
