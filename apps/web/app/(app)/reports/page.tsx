import Link from 'next/link';
import { Empty } from '@/components/messages';
import { withUser } from '@/lib/db';
import { myReports } from '@/lib/report-data';
import { REPORTS } from '@/lib/reports';
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
        <ul className="space-y-2" data-testid="report-list">
          {reports.map((r) => (
            <li key={r}>
              <Link
                href={REPORTS[r].href}
                className="block rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
              >
                <span className="block font-medium">{REPORTS[r].title}</span>
                <span className="block text-sm text-slate-600">{REPORTS[r].blurb}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {/* the cost controller's Menu moved here from the bottom nav (docs/reporting.md 6);
          a card like the reports above it */}
      {shell.domains.has('MENU') && (
        <Link
          href="/menu"
          className="block rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
          data-testid="menu-costs-link"
        >
          <span className="block font-medium">Menu costs and prices</span>
          <span className="block text-sm text-slate-600">
            Cost per serve and cost % of each dish, and its recipe.
          </span>
        </Link>
      )}
    </div>
  );
}
