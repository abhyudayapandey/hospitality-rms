import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATION_NAME, migrationFileName, nextVersion, outOfOrder } from './migration-names';

const dir = join(import.meta.dirname, '..', 'migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));

// Merged before this check existed, and already applied in production after newer files:
// 20261214100000_whole_packs.sql came in with #105. Never add to this list.
const APPLIED_OUT_OF_ORDER = new Set(['20261214100000']);

describe('a new migration (ADR 169)', () => {
  it('is named an hour after the newest file while the files run ahead of the clock', () => {
    const now = new Date('2026-10-17T03:34:31Z');
    expect(nextVersion(['20270118160000_a.sql', '20270101000000_b.sql'], now)).toBe(
      '20270118170000',
    );
    // across midnight and the year end
    expect(nextVersion(['20271231230000_a.sql'], now)).toBe('20280101000000');
  });

  it('takes the current minute once the clock has passed the newest file', () => {
    const now = new Date('2027-03-05T10:20:45Z');
    expect(nextVersion(['20270118160000_a.sql'], now)).toBe('20270305102000');
    expect(nextVersion([], now)).toBe('20270305102000');
  });

  it('always sorts after every file in the folder', () => {
    const name = migrationFileName(files, 'Room notes!', new Date());
    expect(name).toMatch(/^\d{14}_room_notes\.sql$/);
    expect([...files, name].sort().at(-1)).toBe(name);
  });

  it('needs a name', () => {
    expect(() => migrationFileName(files, '  ', new Date())).toThrow(/give the migration a name/);
  });
});

describe('the migrations folder', () => {
  it('holds only well-formed, unique migration names', () => {
    const bad = files.filter((f) => !MIGRATION_NAME.test(f));
    expect(bad).toEqual([]);
    const versions = files.map((f) => f.slice(0, 14));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('flags a file added after a newer one', () => {
    expect(outOfOrder([['20270101000000_a.sql'], ['20270102000000_b.sql']])).toEqual([]);
    expect(
      outOfOrder([['20270101000000_a.sql', '20270103000000_c.sql'], ['20270102000000_b.sql']]),
    ).toEqual(['20270102000000']);
  });

  // In the order master took them (each first-parent commit, a merge included), every
  // migration a commit adds sorts after every one already there, so production (which applies
  // them in that order) and a fresh database (name order) run the same files in the same
  // order. CI fetches enough history for this; a shallow clone checks what it has.
  it('were added to master in name order', () => {
    const root = join(dir, '..', '..', '..');
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    try {
      git(['rev-parse', '--git-dir']);
    } catch {
      return; // not a git checkout (a release bundle): nothing to compare
    }
    const log = git([
      'log',
      '--first-parent',
      '-m',
      '--reverse',
      '--diff-filter=A',
      '--name-only',
      '--format=format:@@',
      '--',
      'packages/db/migrations',
    ]);
    const steps = log
      .split('@@')
      .map((s) =>
        s
          .split('\n')
          .map((l) => l.trim().split('/').at(-1)!)
          .filter(Boolean),
      )
      .filter((s) => s.length > 0);
    expect(outOfOrder(steps).filter((v) => !APPLIED_OUT_OF_ORDER.has(v))).toEqual([]);
    // the whole history's log: quick alone, past 5 s beside the full unit run
  }, 60_000);
});
