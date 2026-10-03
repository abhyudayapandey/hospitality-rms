import type { ImportReport } from '@outlet-ops/onboarding/upload';

// An import's report (ADR 013): what it creates or changes per table, every problem with
// file, row and column, and the approval-coverage warnings.

const where = (i: { file: string; row?: number; column?: string }) =>
  [i.file, i.row && `row ${i.row}`, i.column].filter(Boolean).join(' · ');

export function ImportReportView({ report }: { report: ImportReport }) {
  const tables = Object.entries(report.counts);
  const summary = !report.ok
    ? `${report.issues.length} problem${report.issues.length === 1 ? '' : 's'}: nothing was changed.`
    : report.changes === 0
      ? report.applied
        ? 'Applied. No changes: everything in these files was already loaded.'
        : 'Dry run: no changes. Everything in these files is already loaded.'
      : report.applied
        ? `Applied: ${report.changes} change${report.changes === 1 ? '' : 's'}.`
        : `Dry run: applying would make ${report.changes} change${report.changes === 1 ? '' : 's'}.`;
  return (
    <section className="space-y-3" aria-label="Import report">
      <p data-testid="import-summary" className="font-medium">
        {summary}
      </p>
      {report.issues.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-rose-50 p-3 text-sm text-rose-900">
          {report.issues.map((i, n) => (
            <li key={n}>
              <span className="font-mono text-xs">{where(i)}</span> {i.message}
            </li>
          ))}
        </ul>
      )}
      {report.warnings.length > 0 && (
        <div className="space-y-1 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-medium">{report.warnings.length} warning(s)</p>
          <ul className="space-y-1">
            {report.warnings.map((w, n) => (
              <li key={n}>
                <span className="font-mono text-xs">{where(w)}</span> {w.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {tables.length > 0 && (
        <table className="w-full rounded-lg bg-white text-sm ring-1 ring-slate-200">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="p-2 font-medium">Table</th>
              <th className="p-2 text-right font-medium">New</th>
              <th className="p-2 text-right font-medium">Changed</th>
              <th className="p-2 text-right font-medium">Same</th>
            </tr>
          </thead>
          <tbody>
            {tables.map(([table, c]) => (
              <tr key={table} className="border-t border-slate-100" data-table={table}>
                <td className="p-2">{table}</td>
                <td className="p-2 text-right">{c.created}</td>
                <td className="p-2 text-right">{c.updated}</td>
                <td className="p-2 text-right">{c.unchanged}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-xs text-slate-500">Files read: {report.files.join(', ')}</p>
    </section>
  );
}
