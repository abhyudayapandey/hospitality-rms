import { relative } from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

// Shards by expected time, not by number of files (ADR 029). Vitest's own sharding gives
// each shard the same number of files, so one shard can get all the slow ones. Here each
// file goes to the shard with the least expected time so far, slowest first. The weights
// are seconds per file on CI, two workers a shard: the "DB test times" step of each db job
// prints them ready to paste (print-times.mjs; 2026-10-05). Re-measure when one shard runs
// much longer than the other; local timings differ too much to use. Any other file counts as
// DEFAULT. Stale weights only make the shards less even, never skip a file. No file should
// take much more than a quarter of the total: a file runs on one worker, so the slowest file
// sets the floor (ADR 052 split reports-refusals and the loader tests in two for this).
export const WEIGHTS: Readonly<Record<string, number>> = {
  'packages/onboarding/src/loader-checks.db.test.ts': 217,
  'packages/onboarding/src/loader.db.test.ts': 150,
  // ADR 057, measured locally (130 s): re-measure on CI with the rest
  'packages/db/src/reports-reconcile.db.test.ts': 145,
  'packages/db/src/reports-refusals-2.db.test.ts': 141,
  'packages/db/src/reports-refusals-1.db.test.ts': 140,
  'packages/db/src/rls-equivalence.db.test.ts': 134,
  'packages/onboarding/src/menu.db.test.ts': 109,
  // ADR 059, four loads of Test Company (14 s locally): re-measure on CI with the rest
  'packages/onboarding/src/duties-loader.db.test.ts': 75,
  'packages/onboarding/src/role-cover-loader.db.test.ts': 90,
  'packages/onboarding/src/import.db.test.ts': 72,
  'packages/db/src/reports-access.db.test.ts': 68,
  'packages/onboarding/src/derived.db.test.ts': 53,
  'packages/db/src/labour-cost.db.test.ts': 28,
  'packages/db/src/workflow.db.test.ts': 14,
  'packages/onboarding/src/create.db.test.ts': 12,
  // ADR 064, 14 loads of a new customer (10 s locally): re-measure on CI with the rest
  'packages/onboarding/src/setup-draft.db.test.ts': 20,
  'packages/db/src/workforce-flows.db.test.ts': 11,
  'packages/db/src/screen-places.db.test.ts': 9,
  'packages/db/src/expiry.db.test.ts': 8,
  'packages/db/src/user-admin.db.test.ts': 8,
  'packages/db/src/approval-chains.db.test.ts': 6,
  'packages/db/src/po5-rfm.db.test.ts': 6,
  'packages/db/src/access-groups.db.test.ts': 5,
  'packages/db/src/inventory-perf.db.test.ts': 5,
  'packages/db/src/menu-access.db.test.ts': 5,
  'packages/db/src/attendance.db.test.ts': 4,
  'packages/db/src/inventory.db.test.ts': 4,
  'packages/db/src/po-send.db.test.ts': 4,
  'packages/db/src/pos-import.db.test.ts': 4,
  'packages/db/src/profile.db.test.ts': 4,
  'packages/db/src/report-breakdowns.db.test.ts': 4,
  'packages/db/src/rostering.db.test.ts': 4,
  'packages/db/src/selfie-device.db.test.ts': 4,
};
const DEFAULT = 3;

export default class TimedSequencer extends BaseSequencer {
  private weight(spec: TestSpecification): number {
    return WEIGHTS[relative(this.ctx.config.root, spec.moduleId)] ?? DEFAULT;
  }

  override shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard!;
    const load = new Array<number>(count).fill(0);
    const mine: TestSpecification[] = [];
    const ordered = [...files].sort(
      (a, b) => this.weight(b) - this.weight(a) || a.moduleId.localeCompare(b.moduleId),
    );
    for (const spec of ordered) {
      const shard = load.indexOf(Math.min(...load));
      load[shard] = (load[shard] ?? 0) + this.weight(spec);
      if (shard === index - 1) mine.push(spec);
    }
    return Promise.resolve(mine);
  }

  // the slowest files start first, so a worker isn't left with one long file at the end
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    // stable: Vitest's order (one project after another) except slowest first in a project
    return sorted.sort(
      (a, b) =>
        (a.project.name === b.project.name ? 0 : a.project.name < b.project.name ? -1 : 1) ||
        this.weight(b) - this.weight(a),
    );
  }
}
