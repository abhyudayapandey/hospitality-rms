import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The repository is public (ADR 166): no committed document may give a working password or
// the old pattern that made them ("Test" + the job title + "!12"), which signed anyone in to
// a demo company in production, its presenter too. Logins get random one-time passwords on
// the printed sheet.

const root = join(import.meta.dirname, '..', '..', '..');

const PATTERNS = [
  /Test[A-Z][A-Za-z]*![0-9]+/, // TestBarManager!12
  /Test<[A-Za-z]+>![0-9]+/, // Test<Role>!12
  /`!12`/, // "`Test` + job title + `!12`"
];

/** Every committed text file people read: docs, READMEs, the website, the test data. */
function committedDocs(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  return out
    .split('\0')
    .filter(Boolean)
    .filter((f) => /\.(md|mdx|txt|csv|html)$/i.test(f));
}

describe('no passwords in committed documents (ADR 166)', () => {
  it('none gives the old Test<Role>!12 passwords or their rule', () => {
    const files = committedDocs();
    expect(files.length).toBeGreaterThan(50);
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(join(root, f), 'utf8');
      text.split('\n').forEach((line, n) => {
        if (PATTERNS.some((p) => p.test(line))) hits.push(`${f}:${n + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('the check finds the old pattern (so it can fail)', () => {
    for (const line of [
      '| `passport.presenter` | `TestAccountOwner!12` |',
      'Set passwords by the Test<Role>!12 rule',
      'Each password is `Test` + the job title without spaces + `!12`:',
    ]) {
      expect(
        PATTERNS.some((p) => p.test(line)),
        line,
      ).toBe(true);
    }
  });
});
