/* global process, console */
// Prints each DB test file's seconds from Vitest's JSON report, slowest first, as lines for
// the WEIGHTS table in sequencer.ts (ADR 029, 052). CI runs it after each DB shard, so the
// weights can be re-measured from CI's own machines: paste both shards' lines into WEIGHTS.
// Usage: node packages/db/test/print-times.mjs <report.json>
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const rows = report.testResults
  .map((t) => [relative(process.cwd(), t.name), Math.round((t.endTime - t.startTime) / 1000)])
  .sort((a, b) => b[1] - a[1]);
const total = rows.reduce((s, [, x]) => s + x, 0);
console.log(`DB test files: ${rows.length}, ${total} s in all; weights (4 s or more):`);
for (const [file, s] of rows.filter(([, x]) => x >= 4)) console.log(`  '${file}': ${s},`);
