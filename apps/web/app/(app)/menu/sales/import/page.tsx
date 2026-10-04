import { BackLink } from '@/components/back-link';
import { Empty } from '@/components/messages';
import { PlaceSwitcher } from '@/components/place-switcher';
import { formatDay, formatTime } from '@/lib/dates';
import { withUser } from '@/lib/db';
import { formatMoney } from '@/lib/format';
import { param, type SearchParams } from '@/lib/params';
import { placesFor } from '@/lib/places';
import { posDishes, posImportOf } from '@/lib/pos-import';
import { isoDate, todayIn } from '@/lib/production';
import { reportToday } from '@/lib/report-data';
import { ImportForm } from './import-form';
import { MatchForm } from './match-form';

// The POS import (SAL-2, ADR 039): the cashier's end-of-day job. They export the day's
// "Sale by item" report from the POS and upload it here; each POS code is matched to a menu
// item through the outlet's own list, never guessed. Codes nobody has matched yet are
// listed; the cashier matches them to a dish here and posts the day again. Changing a code
// already matched is for the people who post the outlet's sales.
export default async function PosImportPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const { shell, places, place } = await placesFor('pos_import', searchParams);
  if (!place) return <Empty>You don&apos;t import sales anywhere.</Empty>;
  const tz = place.timezone ?? 'Asia/Kolkata';
  const max = todayIn(tz);
  const data = await withUser(shell.user.id, async (tx) => {
    // the business day: after midnight, the night before is still being closed (ADR 037)
    const day = await reportToday(tx, place.id);
    const asked = isoDate(param(sp, 'date'), day);
    const date = asked > max ? day : asked;
    const last = await posImportOf(tx, place.id, date);
    const menu = last && last.unmatched.length > 0 ? await posDishes(tx, place.id) : [];
    return { date, last, menu };
  });
  const { date, last, menu } = data;
  return (
    <div className="space-y-4">
      <BackLink />
      <PlaceSwitcher screen="pos_import" places={places} current={place.id} quiet />
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Import sales</h1>
        <p className="truncate text-sm text-slate-600" data-testid="pos-outlet">
          {place.name}
        </p>
      </div>
      <form className="flex items-end gap-2" action="/menu/sales/import">
        <input type="hidden" name="node" value={place.id} />
        <label className="flex-1 space-y-1">
          <span className="text-sm">Day</span>
          <input
            type="date"
            name="date"
            max={max}
            defaultValue={date}
            className="min-h-12 w-full rounded-lg border border-slate-300 bg-white px-3"
          />
        </label>
        <button className="min-h-12 rounded-lg border border-slate-300 bg-white px-4">Show</button>
      </form>

      {last ? (
        <section
          aria-label="Imported"
          className="space-y-2 rounded-2xl bg-white p-4 ring-1 ring-slate-200"
          data-testid="pos-last"
        >
          <p className="font-semibold text-emerald-800">
            {formatDay(date)}: imported at {formatTime(last.imported_at, tz)}
            {last.imported_by ? ` by ${last.imported_by}` : ''}
          </p>
          <p className="text-sm text-slate-600 tabular-nums" data-testid="pos-summary">
            {last.posted} {last.posted === 1 ? 'item' : 'items'} · {formatMoney(last.net)} taken
            {Number(last.discount) > 0 ? ` · ${formatMoney(last.discount)} discount` : ''} ·{' '}
            {last.file_name}
          </p>
          {last.unmatched.length > 0 && (
            <div className="space-y-2" data-testid="pos-unmatched">
              <p className="text-sm font-semibold text-amber-800">
                {last.unmatched.length} POS {last.unmatched.length === 1 ? 'code is' : 'codes are'}{' '}
                not matched to the menu yet, so{' '}
                {last.unmatched.length === 1 ? 'it was' : 'they were'} not counted:
              </p>
              <MatchForm
                outlet={place.id}
                importId={last.id}
                unmatched={last.unmatched}
                menu={menu}
              />
            </div>
          )}
        </section>
      ) : (
        <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900" data-testid="pos-none">
          Not imported yet for {formatDay(date)}.
        </p>
      )}

      <ImportForm key={`${place.id}-${date}`} outlet={place.id} date={date} again={last !== null} />

      <p className="text-xs text-slate-500">
        In the POS, open the <strong>Sale by item</strong> report for this one day and export it to
        Excel. Importing a day again replaces it, and it replaces sales typed in for that day.
      </p>
    </div>
  );
}
