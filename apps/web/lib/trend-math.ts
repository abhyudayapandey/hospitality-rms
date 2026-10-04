// The arithmetic of a trend chart (RPT-12, ADR 041), kept apart from the SVG so it can be
// unit tested: the value range of the chart, where each period sits, and the line through
// the periods that have a value (a period with none breaks the line).

/** The lowest and highest the chart shows: 0 is always in it; stacked bars add up. */
export function chartRange(
  series: readonly (readonly (number | null)[])[],
  stacked: boolean,
): { min: number; max: number } {
  const n = Math.max(0, ...series.map((s) => s.length));
  let min = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    if (stacked) {
      const total = series.reduce((t, s) => t + Math.max(0, s[i] ?? 0), 0);
      max = Math.max(max, total);
    } else {
      for (const s of series) {
        const v = s[i];
        if (v === null || v === undefined) continue;
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    }
  }
  if (max === min) max = min + 1;
  return { min, max };
}

/** The middle of period i of n across a width. */
export function slotX(i: number, n: number, width: number): number {
  return ((i + 0.5) * width) / Math.max(1, n);
}

/** Height on the chart for a value: the top is max, the bottom min (SVG y grows down). */
export function valueY(v: number, min: number, max: number, height: number): number {
  return height - ((v - min) / (max - min)) * height;
}

/** An SVG path through the values, starting again after a period with no value. */
export function linePath(
  values: readonly (number | null)[],
  width: number,
  height: number,
  min: number,
  max: number,
): string {
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    const x = slotX(i, values.length, width).toFixed(2);
    const y = valueY(v, min, max, height).toFixed(2);
    d += `${pen ? 'L' : 'M'}${x} ${y} `;
    pen = true;
  });
  return d.trim();
}
