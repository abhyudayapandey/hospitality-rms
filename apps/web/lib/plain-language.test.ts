import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGES } from '@outlet-ops/domain';
import { fkGrade, syllables, words } from './readability';
import { uiText } from './ui-text';

// Plain words everywhere (ADR 129): the app's text reads at Flesch-Kincaid grade 6 or lower.
// A screen with enough words to measure (30 or more) is at grade 6 or lower, so is the app as a
// whole, and no sentence runs past 20 words. One label alone ("Notifications") is not a
// passage, so a screen of a few words is not graded; its words still count in the whole.

const WEB = join(import.meta.dirname, '..');
const MAX_GRADE = 6;
const MIN_WORDS = 30;
const MAX_SENTENCE = 20;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? files(join(dir, d.name))
      : d.name.endsWith('.tsx') && !d.name.endsWith('.test.tsx')
        ? [join(dir, d.name)]
        : [],
  );
}

const screens = [...files(join(WEB, 'app')), ...files(join(WEB, 'components'))].map((f) => ({
  name: f.slice(WEB.length + 1),
  lines: uiText(readFileSync(f, 'utf8'), f),
}));

describe('reading level', () => {
  it('counts syllables and grades text', () => {
    expect(syllables('cat')).toBe(1);
    expect(syllables('table')).toBe(2);
    expect(syllables('approval')).toBe(3);
    expect(fkGrade(['Take a photo.', 'Mark it done.'])).toBeLessThan(3);
    expect(
      fkGrade(['Sensitive authorisation configuration necessitates administrative intervention.']),
    ).toBeGreaterThan(12);
  });

  it('finds the words on the screens', () => {
    expect(screens.flatMap((s) => s.lines).length).toBeGreaterThan(2000);
  });

  it('the app as a whole reads at grade 6 or lower', () => {
    expect(fkGrade(screens.flatMap((s) => s.lines))).toBeLessThanOrEqual(MAX_GRADE);
  });

  it.each(
    screens
      .filter((s) => s.lines.flatMap(words).length >= MIN_WORDS)
      .map((s) => [s.name, s.lines] as const),
  )('%s reads at grade 6 or lower', (_name, lines) => {
    expect(fkGrade(lines)).toBeLessThanOrEqual(MAX_GRADE);
  });

  it('the messages for refusals and errors read at grade 6 or lower', () => {
    expect(fkGrade(Object.values(ERROR_MESSAGES))).toBeLessThanOrEqual(MAX_GRADE);
  });

  it('no sentence runs past 20 words', () => {
    const errors = { name: 'ERROR_MESSAGES', lines: Object.values(ERROR_MESSAGES) as string[] };
    const long = [...screens, errors].flatMap((s) =>
      s.lines
        .flatMap((l) => l.split(/(?<=[.!?;])\s+/))
        .filter((sentence) => words(sentence).length > MAX_SENTENCE)
        .map((sentence) => `${s.name}: ${sentence}`),
    );
    expect(long).toEqual([]);
  });
});
