import Link from 'next/link';
import { Empty } from '@/components/messages';
import { withUser } from '@/lib/db';
import { myReports } from '@/lib/report-data';
import { groupReports, REPORTS } from '@/lib/reports';
import { loadShell } from '@/lib/shell';

// The reports a person can open (ADR 023), in the order of docs/reporting.md section 5.
// rpt.my_reports() decides the list; each report checks again at its place.
export default async function ReportsPage() {
  const shell = await loadShell();
  const reports = await withUser(shell.user.id, myReports);
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Reports</h1>
      {reports.length === 0 ? (
        <Empty>No reports for you yet.</Empty>
      ) : (
        <div className="space-y-5" data-testid="report-list">
          {groupReports(reports).map((g) => (
            <section key={g.title} aria-label={g.title} className="space-y-2">
              <h2 className="text-sm font-semibold text-slate-700">{g.title}</h2>
              <ul className="space-y-2">
                {g.reports.map((r) => (
                  <li key={r}>
                    <Link
                      href={REPORTS[r].href}
                      className="block rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
                    >
                      <span className="block font-medium">
                        {REPORTS[r].title}
                        {r === reports[0] && (
                          <span
                            className="ml-2 rounded-full bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700"
                            data-testid="start-here"
                          >
                            Start here
                          </span>
                        )}
                      </span>
                      <span className="block text-sm text-slate-600">{REPORTS[r].blurb}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {/* the cost controller's Menu moved here from the bottom nav (docs/reporting.md 6);
          a card like the reports above it */}
      {shell.domains.has('MENU') && (
        <Link
          href="/menu"
          className="block rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
          data-testid="menu-costs-link"
        >
          <span className="block font-medium">Menu: recipes and prices</span>
          <span className="block text-sm text-slate-600">
            Cost per serve and cost % of each dish, and its recipe.
          </span>
        </Link>
      )}
    </div>
  );
}
