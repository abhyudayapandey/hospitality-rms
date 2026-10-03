import { relative } from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

// Shards by expected time, not by number of files (ADR 029). Vitest's own sharding gives
// each shard the same number of files, so one shard can get all the slow ones. Here each
// file goes to the shard with the least expected time so far, slowest first. The weights
// are seconds alone on one core (`--reporter=json`, 2026-10-03); any other file counts as
// DEFAULT. Stale weights only make the shards less even, never skip a file.
const WEIGHTS: Readonly<Record<string, number>> = {
  'packages/db/src/rls-equivalence.db.test.ts': 213,
  'packages/db/src/reports-refusals.db.test.ts': 122,
  'packages/onboarding/src/loader.db.test.ts': 78,
  'packages/db/src/reports-access.db.test.ts': 53,
  'packages/onboarding/src/menu.db.test.ts': 20,
  'packages/db/src/screen-places.db.test.ts': 14,
  'packages/onboarding/src/import.db.test.ts': 13,
  'packages/db/src/workforce-flows.db.test.ts': 11,
  'packages/onboarding/src/derived.db.test.ts': 10,
  'packages/db/src/menu-access.db.test.ts': 9,
  'packages/db/src/inventory-perf.db.test.ts': 9,
  'packages/db/src/workforce-schema.db.test.ts': 8,
  'packages/db/src/profile.db.test.ts': 7,
  'packages/db/src/user-admin.db.test.ts': 7,
  'packages/db/src/access-groups.db.test.ts': 6,
  'packages/db/src/rostering.db.test.ts': 6,
  'packages/db/src/workflow.db.test.ts': 5,
};
const DEFAULT = 3;

export default class TimedSequencer extends BaseSequencer {
  private weight(spec: TestSpecification): number {
    return WEIGHTS[relative(this.ctx.config.root, spec.moduleId)] ?? DEFAULT;
  }

  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
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
    return mine;
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
