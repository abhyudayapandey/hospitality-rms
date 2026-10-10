// A recipe's method with pictures (ADR 100): the ingredients a step names and the minutes it
// takes. No server imports: the recipe page and a prep task's Method both use it.

/** One word's singular-ish form: "onions" and "onion", "tomatoes" and "tomato" compare equal. */
function stem(word: string): string {
  const w = word.toLowerCase();
  if (w.length > 4 && w.endsWith('oes')) return w.slice(0, -2);
  if (w.length > 4 && /(ches|shes|sses|xes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(stem);
}

/**
 * The ingredients a step names, in the order the step names them: an ingredient's whole name,
 * word for word (case and plurals aside), inside the step's words, else its last word when
 * no other ingredient ends in it ("the rice" names Basmati rice). "Add the onions" names
 * Onion; "onionskin" does not. A name inside a longer one that also matches ("Milk" in
 * "Coconut milk" at the same place) gives way to the longer one.
 */
export function ingredientsInStep<T extends { name: string }>(text: string, ingredients: T[]): T[] {
  const said = words(text);
  const hits: { item: T; at: number; len: number }[] = [];
  const find = (name: string[]) => {
    for (let i = 0; i + name.length <= said.length; i++) {
      if (name.every((w, j) => said[i + j] === w)) return i;
    }
    return -1;
  };
  const names = ingredients.map((i) => words(i.name));
  const lastOf = names.map((n) => n.at(-1));
  ingredients.forEach((item, k) => {
    const name = names[k]!;
    if (name.length === 0) return;
    const at = find(name);
    if (at >= 0) {
      hits.push({ item, at, len: name.length });
      return;
    }
    // "Basmati rice" in "wash the rice": its last word, when no other ingredient ends in it
    const last = lastOf[k]!;
    if (name.length > 1 && last.length > 2 && lastOf.filter((l) => l === last).length === 1) {
      const t = find([last]);
      if (t >= 0) hits.push({ item, at: t, len: 1 });
    }
  });
  const kept = hits.filter(
    (h) =>
      !hits.some((o) => o !== h && o.len > h.len && o.at <= h.at && o.at + o.len >= h.at + h.len),
  );
  const seen = new Set<T>();
  return kept
    .sort((a, b) => a.at - b.at)
    .map((h) => h.item)
    .filter((i) => (seen.has(i) ? false : (seen.add(i), true)));
}

/** The minutes a step takes: its own figure, else the last "N min" its words name. */
export function stepMinutes(text: string, minutes: number | null | undefined): number | null {
  if (minutes && minutes > 0) return minutes;
  const m = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(?:min|mins|minute|minutes)\b/gi)];
  const last = m.at(-1);
  if (!last) return null;
  const n = Number(last[1]);
  return n > 0 && n <= 24 * 60 ? n : null;
}
