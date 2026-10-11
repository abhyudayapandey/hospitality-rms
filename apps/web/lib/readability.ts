// How hard a piece of text is to read (ADR 129): the Flesch-Kincaid grade, the US school year
// a reader needs. The app's words aim at grade 6 or lower: frontline people read it on a
// phone between jobs, many in their second or third language.

/** Syllables in one English word, by its vowel groups (good enough for a grade). */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const trimmed = w.replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const groups = trimmed.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}

/** The words of a text: letters only, so numbers, codes and symbols don't count. */
export function words(text: string): string[] {
  return text.match(/[A-Za-z][A-Za-z']*/g) ?? [];
}

/**
 * The Flesch-Kincaid grade of some lines of text. Each line is at least one sentence: a label
 * or a button is a sentence of its own, as a reader takes it in.
 */
export function fkGrade(lines: readonly string[]): number {
  let sentences = 0;
  let wordCount = 0;
  let syllableCount = 0;
  for (const line of lines) {
    const ws = words(line);
    if (ws.length === 0) continue;
    sentences += Math.max(1, (line.match(/[.!?]+(\s|$)/g) ?? []).length);
    wordCount += ws.length;
    syllableCount += ws.reduce((n, w) => n + syllables(w), 0);
  }
  if (wordCount === 0) return 0;
  return 0.39 * (wordCount / sentences) + 11.8 * (syllableCount / wordCount) - 15.59;
}
