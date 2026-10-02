import Link from 'next/link';
import { NoReport, ReportHeader, ReportSections } from '@/components/report-view';
import { addDays, formatDay, isIsoDate, localToday, weekStart } from '@/lib/dates';
import { withUser } from '@/lib/db';
import { failure } from '@outlet-ops/domain';
import { param, type SearchParams } from '@/lib/params';
import { myWeek } from '@/lib/report-data';
import { loadShell } from '@/lib/shell';

// The person's own week (Monday to Sunday): shifts, hours, on-time record and tasks.
// Only their own figures; frontline staff see no other report (ADR 023).
export default async function MyWeekReport({ searchParams }: { searchParams: SearchParams }) {
  const shell = await loadShell();
  const tz = shell.nodes.find((n) => n.id === shell.home?.id)?.timezone ?? undefined;
  const asked = param(await searchParams, 'week');
  const thisWeek = weekStart(localToday(tz));
  const monday = isIsoDate(asked) && asked <= thisWeek ? weekStart(asked) : thisWeek;
  let rows;
  try {
    rows = await withUser(shell.user.id, (tx) => myWeek(tx, monday));
  } catch (err) {
    return <NoReport>{failure(err).message}</NoReport>;
  }
  const box = 'flex min-h-11 min-w-11 items-center justify-center rounded-lg ring-1 ring-slate-300';
  return (
    <div className="space-y-4">
      <ReportHeader report="my_week" />
      <div className="flex items-center justify-between gap-2">
        <Link
          href={`/reports/my-week?week=${addDays(monday, -7)}`}
          aria-label="Week before"
          className={box}
        >
          ←
        </Link>
        <p className="text-center font-medium" data-testid="report-week">
          {monday === thisWeek ? 'This week' : `Week of ${formatDay(monday)}`}
        </p>
        {monday < thisWeek ? (
          <Link
            href={`/reports/my-week?week=${addDays(monday, 7)}`}
            aria-label="Week after"
            className={box}
          >
            →
          </Link>
        ) : (
          <span className="min-w-11" />
        )}
      </div>
      <ReportSections report="my_week" rows={rows} />
      <Link href="/leave" className="block text-sm text-slate-700 underline">
        Leave balance and requests
      </Link>
    </div>
  );
}
