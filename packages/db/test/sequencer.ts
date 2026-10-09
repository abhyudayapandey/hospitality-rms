import { relative } from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

// Shards by expected time, not by number of files (ADR 029). Vitest's own sharding gives
// each shard the same number of files, so one shard can get all the slow ones. Here each
// file goes to the shard with the least expected time so far, slowest first. The weights
// are seconds per file on CI, two workers a shard: the "DB test times" step of each db job
// prints them ready to paste (print-times.mjs; 2026-10-09). Re-measure when one shard runs
// much longer than the other; local timings differ too much to use. Any other file counts as
// DEFAULT. Stale weights only make the shards less even, never skip a file. No file should
// take much more than a quarter of the total: a file runs on one worker, so the slowest file
// sets the floor (ADR 052 split reports-refusals and the loader tests in two for this).
export const WEIGHTS: Readonly<Record<string, number>> = {
  'packages/db/src/rls-equivalence.db.test.ts': 286,
  'packages/onboarding/src/loader-checks.db.test.ts': 252,
  'packages/onboarding/src/setup-draft.db.test.ts': 146,
  'packages/db/src/reports-refusals-2.db.test.ts': 142,
  // a load per outlet template; it timed out shard 1 before it had a weight (2026-10-09,
  // 144 s alone locally, like setup-draft): re-measure on CI with the rest
  'packages/onboarding/src/outlet-template.db.test.ts': 140,
  'packages/onboarding/src/menu.db.test.ts': 132,
  'packages/db/src/reports-refusals-1.db.test.ts': 107,
  'packages/db/src/reports-reconcile.db.test.ts': 90,
  'packages/onboarding/src/import.db.test.ts': 87,
  'packages/db/src/task-handover.db.test.ts': 73,
  'packages/onboarding/src/retire-store.db.test.ts': 73,
  'packages/onboarding/src/derived.db.test.ts': 61,
  'packages/db/src/reports-access.db.test.ts': 49,
  'packages/db/src/menu-access.db.test.ts': 40,
  'packages/db/src/labour-cost.db.test.ts': 33,
  'packages/db/src/tenant-isolation.db.test.ts': 32,
  'packages/onboarding/src/loader.db.test.ts': 31,
  'packages/onboarding/src/role-cover-loader.db.test.ts': 29,
  'packages/onboarding/src/passport-demo.db.test.ts': 25,
  'packages/onboarding/src/duties-loader.db.test.ts': 19,
  'packages/onboarding/src/create.db.test.ts': 11,
  'packages/onboarding/src/dish-photos.db.test.ts': 11,
  'packages/db/src/dish-photos-methods.db.test.ts': 10,
  'packages/db/src/role-cover.db.test.ts': 9,
  'packages/db/src/screen-places.db.test.ts': 9,
  'packages/db/src/user-admin.db.test.ts': 8,
  'packages/db/src/workforce-flows.db.test.ts': 8,
  'packages/db/src/access-groups.db.test.ts': 7,
  'packages/db/src/expiry.db.test.ts': 6,
  'packages/db/src/who-does-what.db.test.ts': 6,
  'packages/db/src/po5-rfm.db.test.ts': 5,
  'packages/db/src/selfie-device.db.test.ts': 5,
  'packages/db/src/test-customers.db.test.ts': 5,
  'packages/db/src/workflow.db.test.ts': 5,
  'packages/db/src/inventory-perf.db.test.ts': 4,
  'packages/db/src/inventory.db.test.ts': 4,
  'packages/db/src/measure-trends.db.test.ts': 4,
  'packages/db/src/pos-import.db.test.ts': 4,
  'packages/db/src/report-breakdowns.db.test.ts': 4,
  'packages/db/src/rostering.db.test.ts': 4,
  'packages/db/src/tasks-access.db.test.ts': 4,
  'packages/db/src/workforce-schema.db.test.ts': 4,
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
