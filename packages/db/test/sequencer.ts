import { relative } from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

// Shards by expected time, not by number of files (ADR 029). Vitest's own sharding gives
// each shard the same number of files, so one shard can get all the slow ones. Here each
// file goes to the shard with the least expected time so far, slowest first. The weights
// are seconds per file on CI: the "DB test times" step of each db job prints them ready to
// paste (print-times.mjs; 2026-10-11, from #107's run, after shard 2 of 2 ran out of time
// on master with weights from 2026-10-09 that put the slowest loader files together).
// Re-measure when one shard runs much longer than the others; local timings differ too much
// to use. Any other file counts as DEFAULT. Stale weights only make the shards less even,
// never skip a file. No file should take much more than a third of the total: a file runs
// on one worker, so the slowest file sets the floor (ADR 052 split reports-refusals and the
// loader tests in two for this).
export const WEIGHTS: Readonly<Record<string, number>> = {
  'packages/onboarding/src/outlet-template.db.test.ts': 615,
  'packages/onboarding/src/loader-checks.db.test.ts': 426,
  'packages/db/src/rls-equivalence.db.test.ts': 329,
  'packages/db/src/reports-refusals-1.db.test.ts': 210,
  'packages/db/src/reports-refusals-2.db.test.ts': 208,
  'packages/db/src/reports-access.db.test.ts': 189,
  'packages/onboarding/src/loader.db.test.ts': 189,
  'packages/onboarding/src/role-cover-loader.db.test.ts': 174,
  'packages/onboarding/src/menu.db.test.ts': 135,
  'packages/onboarding/src/duties-loader.db.test.ts': 129,
  'packages/onboarding/src/setup-draft.db.test.ts': 129,
  'packages/db/src/reports-reconcile.db.test.ts': 122,
  'packages/onboarding/src/import.db.test.ts': 99,
  'packages/db/src/task-handover.db.test.ts': 93,
  'packages/onboarding/src/passport-demo.db.test.ts': 86,
  'packages/onboarding/src/derived.db.test.ts': 76,
  'packages/onboarding/src/dish-photos.db.test.ts': 70,
  'packages/onboarding/src/retire-store.db.test.ts': 68,
  'packages/db/src/menu-access.db.test.ts': 48,
  'packages/db/src/labour-cost.db.test.ts': 40,
  'packages/db/src/workflow.db.test.ts': 39,
  'packages/onboarding/src/create.db.test.ts': 17,
  'packages/db/src/tenant-isolation.db.test.ts': 14,
  'packages/db/src/workforce-flows.db.test.ts': 14,
  'packages/db/src/dish-photos-methods.db.test.ts': 13,
  'packages/db/src/screen-places.db.test.ts': 12,
  'packages/db/src/role-cover.db.test.ts': 11,
  'packages/db/src/approval-chains.db.test.ts': 9,
  'packages/db/src/expiry.db.test.ts': 9,
  'packages/db/src/homes.db.test.ts': 9,
  'packages/db/src/po5-rfm.db.test.ts': 8,
  'packages/db/src/requisition-chain.db.test.ts': 8,
  'packages/db/src/user-admin.db.test.ts': 8,
  'packages/db/src/inventory-perf.db.test.ts': 7,
  'packages/db/src/league.db.test.ts': 7,
  'packages/db/src/access-groups.db.test.ts': 6,
  'packages/db/src/workforce-schema.db.test.ts': 6,
  'packages/db/src/attendance.db.test.ts': 5,
  'packages/db/src/checklist-signoff.db.test.ts': 5,
  'packages/db/src/inventory.db.test.ts': 5,
  'packages/db/src/po-send.db.test.ts': 5,
  'packages/db/src/pos-import.db.test.ts': 5,
  'packages/db/src/profile.db.test.ts': 5,
  'packages/db/src/report-breakdowns.db.test.ts': 5,
  'packages/db/src/rostering.db.test.ts': 5,
  'packages/db/src/selfie-device.db.test.ts': 5,
  'packages/db/src/tasks-access.db.test.ts': 5,
  'packages/db/src/who-does-what.db.test.ts': 5,
  'packages/db/src/admin-guardrails.db.test.ts': 4,
  'packages/db/src/audits.db.test.ts': 4,
  'packages/db/src/blocks.db.test.ts': 4,
  'packages/db/src/cost-reports.db.test.ts': 4,
  'packages/db/src/measure-trends.db.test.ts': 4,
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
