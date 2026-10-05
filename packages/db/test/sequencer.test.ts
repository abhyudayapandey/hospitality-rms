import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WEIGHTS } from './sequencer';

const ROOT = join(import.meta.dirname, '..', '..', '..');

describe('DB test shard weights (ADR 029, 052)', () => {
  it('name files that exist: a renamed or split file would fall back to the default', () => {
    expect(Object.keys(WEIGHTS).filter((f) => !existsSync(join(ROOT, f)))).toEqual([]);
  });
  it('no file is more than a third of the time: one file runs on one worker', () => {
    const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    expect(Math.max(...Object.values(WEIGHTS))).toBeLessThan(total / 3);
  });
});
