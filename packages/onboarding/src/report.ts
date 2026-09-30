import type { Counts } from './apply';
import type { Issue } from './files';

// What an import job reports back to the console (ADR 013): counts per table, every
// problem with file, row and column, and the approval-coverage warnings. The access
// preview (file 99 layout) stays out: the console links to the customer's own screens.

export interface ImportReport {
  ok: boolean;
  applied: boolean;
  /** Rows the load creates or changes, over all tables; 0 means no changes. */
  changes: number;
  counts: Record<string, Counts>;
  issues: Issue[];
  warnings: Issue[];
  files: string[];
}

/** An invite job's progress. */
export interface InviteProgress {
  sent: number;
  waiting: number;
}
