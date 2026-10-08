import type { ImportReport } from '@outlet-ops/onboarding/upload';
import { countLabel } from '../../parts';

// What an upload of a customer's files changes (ADR 013, 077): per kind of thing, as people
// say it; every problem with its file, row and column (to find it in the file); and what is
// worth a look.

const where = (i: { file: string; row?: number; column?: string }) =>
  [i.file, i.row && `row ${i.row}`, i.column].filter(Boolean).join(' · ');

export function ImportReportView({ report }: { report: ImportReport }) {
  const tables = Object.entries(report.counts);
  const summary = !report.ok
    ? `${report.issues.length} problem${report.issues.length === 1 ? '' : 's'} to fix in the files: nothing was changed.`
    : report.changes === 0
      ? report.applied
        ? 'Loaded. Nothing changed: everything in these files was already there.'
        : 'Checked: nothing would change. Everything in these files is already there.'
      : report.applied
        ? `Loaded: ${report.changes} change${report.changes === 1 ? '' : 's'} made.`
        : `Checked: loading these files would make ${report.changes} change${report.changes === 1 ? '' : 's'}.`;
  return (
    <section className="space-y-3" aria-label="What the files change">
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
          <p className="font-medium">
            {report.warnings.length === 1
              ? 'Worth a look (this doesn’t stop you loading)'
              : `${report.warnings.length} things worth a look (these don’t stop you loading)`}
          </p>
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
              <th className="p-2 font-medium">What</th>
              <th className="p-2 text-right font-medium">New</th>
              <th className="p-2 text-right font-medium">Changed</th>
              <th className="p-2 text-right font-medium">Same</th>
            </tr>
          </thead>
          <tbody>
            {tables.map(([table, c]) => (
              <tr key={table} className="border-t border-slate-100" data-table={table}>
                <td className="p-2">{countLabel(table)}</td>
                <td className="p-2 text-right">{c.created}</td>
                <td className="p-2 text-right">{c.updated}</td>
                <td className="p-2 text-right">{c.unchanged}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-xs text-slate-500">
        {report.files.length} file{report.files.length === 1 ? '' : 's'} read:{' '}
        {report.files.join(', ')}
      </p>
    </section>
  );
}
