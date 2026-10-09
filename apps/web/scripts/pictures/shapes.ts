// Drawn pictures for what Fluent Emoji does not have (ADR 084), in its flat style: a 32 x 32
// view, flat fills, a darker shade for edges and a lighter one for shine. Shared shapes
// (bottle, can, carton, sack, heap, bowl, seeds, folded cloth, spray, roll) take colours and a
// small sign; the rest are drawn one by one in drawn.ts.

export const svg = (body: string) =>
  `<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">\n${body}\n</svg>\n`;

/** a deterministic scatter, so a rebuild draws the same seeds */
export function scatter(n: number, seed: number, box: [number, number, number, number]) {
  const out: { x: number; y: number; r: number }[] = [];
  let s = seed;
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  const [x0, y0, x1, y1] = box;
  for (let i = 0; i < n; i++) {
    out.push({ x: x0 + rnd() * (x1 - x0), y: y0 + rnd() * (y1 - y0), r: rnd() * 360 });
  }
  return out;
}

const f = (n: number) => Number(n.toFixed(2));

export interface BottleOpts {
  glass: string;
  /** the liquid's colour; the glass's when it is the bottle's own colour */
  liquid?: string;
  cap: string;
  label?: string;
  /** a sign drawn on the label, in its own 32 x 32 units, centred at 16, 19 */
  sign?: string;
  shape?: 'wine' | 'spirit' | 'square' | 'squat' | 'beer' | 'round' | 'small' | 'sauce' | 'tall';
}

/** A bottle, its shape saying what it holds: wine, a spirit, a squat bourbon, a beer. */
export function bottle(o: BottleOpts): string {
  const shape = o.shape ?? 'spirit';
  const liquid = o.liquid ?? o.glass;
  const label = o.label ?? '#F4F4F4';
  const bodies: Record<NonNullable<BottleOpts['shape']>, string> = {
    wine: 'M13.5 2.5h5v7.5c0 1.6 2.5 2.8 2.5 6.5v11.5c0 1.1-.9 2-2 2h-6c-1.1 0-2-.9-2-2V16.5c0-3.7 2.5-4.9 2.5-6.5z',
    spirit:
      'M14 2.5h4v5c0 .9 4 1.6 4 5.5v14.5c0 1.1-.9 2-2 2h-8c-1.1 0-2-.9-2-2V13c0-3.9 4-4.6 4-5.5z',
    tall: 'M14.5 2.5h3v6c0 .8 3 1.4 3 4.5v15c0 1.1-.9 2-2 2h-5c-1.1 0-2-.9-2-2V13c0-3.1 3-3.7 3-4.5z',
    square:
      'M14 3h4v4.5h3.5c.8 0 1.5.7 1.5 1.5v18.5c0 1.1-.9 2-2 2H11c-1.1 0-2-.9-2-2V9c0-.8.7-1.5 1.5-1.5H14z',
    squat:
      'M14 4h4v4h3.5c1.4 0 2.5 1.1 2.5 2.5v16.5c0 1.1-.9 2-2 2H10c-1.1 0-2-.9-2-2V10.5C8 9.1 9.1 8 10.5 8H14z',
    beer: 'M14.25 3h3.5v6c0 1.5 2.75 2.3 2.75 5.5v13.5c0 1.1-.9 2-2 2h-5c-1.1 0-2-.9-2-2V14.5c0-3.2 2.75-4 2.75-5.5z',
    round:
      'M14 3h4v5.2c3.6 1 6 4.3 6 8.3v10.5c0 1.1-.9 2-2 2H10c-1.1 0-2-.9-2-2V16.5c0-4 2.4-7.3 6-8.3z',
    small:
      'M14.5 7h3v4c0 .6 3.5 1 3.5 4v12c0 1.1-.9 2-2 2h-6c-1.1 0-2-.9-2-2V15c0-3 3.5-3.4 3.5-4z',
    sauce:
      'M13.5 5h5v3.5c0 .8 3.5 1.5 3.5 5v14c0 1.1-.9 2-2 2h-8c-1.1 0-2-.9-2-2v-14c0-3.5 3.5-4.2 3.5-5z',
  };
  const body = bodies[shape];
  const capY = {
    wine: 1.5,
    spirit: 1.5,
    tall: 1.5,
    square: 2,
    squat: 2.5,
    beer: 2,
    round: 2,
    small: 6,
    sauce: 3,
  }[shape];
  const capH = shape === 'sauce' ? 3 : 2.5;
  const labelY = {
    wine: 17,
    spirit: 15.5,
    tall: 16,
    square: 13,
    squat: 13.5,
    beer: 17,
    round: 16,
    small: 17.5,
    sauce: 16,
  }[shape];
  const labelH = shape === 'beer' ? 7 : shape === 'small' ? 7 : 9;
  const lx = {
    wine: 11.5,
    spirit: 10.5,
    tall: 11.5,
    square: 9.5,
    squat: 8.5,
    beer: 11.5,
    round: 8.5,
    small: 11,
    sauce: 10.5,
  }[shape];
  const lw = 32 - lx * 2;
  const shine = `<path d="M${f(lx + 1)} ${f(labelY + labelH + 1.2)}v3" stroke="#FFFFFF" stroke-opacity=".45" stroke-width="1.2" stroke-linecap="round"/>`;
  return svg(
    [
      `<path d="${body}" fill="${o.glass}"/>`,
      liquid !== o.glass
        ? `<clipPath id="b"><path d="${body}"/></clipPath><rect x="0" y="${f(labelY - 3)}" width="32" height="32" fill="${liquid}" clip-path="url(#b)"/>`
        : '',
      `<rect x="${f(16 - (shape === 'sauce' ? 2.75 : 2.25))}" y="${capY}" width="${shape === 'sauce' ? 5.5 : 4.5}" height="${capH}" rx=".6" fill="${o.cap}"/>`,
      o.label === 'none'
        ? ''
        : `<rect x="${f(lx)}" y="${labelY}" width="${f(lw)}" height="${labelH}" rx="1" fill="${label}"/>`,
      o.sign ? `<g transform="translate(0 ${f(labelY + labelH / 2 - 16)})">${o.sign}</g>` : '',
      shine,
    ].join('\n'),
  );
}

/** A drinks can with a band and a sign. */
export function can(color: string, band: string, sign = ''): string {
  return svg(
    [
      '<path d="M9 7.5c0-1.4 3.1-2.5 7-2.5s7 1.1 7 2.5v18c0 1.4-3.1 2.5-7 2.5s-7-1.1-7-2.5z" fill="' +
        color +
        '"/>',
      '<ellipse cx="16" cy="7.3" rx="7" ry="2.3" fill="#D3D3D3"/>',
      '<ellipse cx="16" cy="7.3" rx="5.4" ry="1.5" fill="#B4B4B4"/>',
      '<rect x="14.6" y="6.6" width="2.8" height="1.3" rx=".6" fill="#8C8C8C"/>',
      `<path d="M9 13h14v7H9z" fill="${band}"/>`,
      sign,
      '<path d="M10.8 11v13" stroke="#FFFFFF" stroke-opacity=".35" stroke-width="1.2" stroke-linecap="round"/>',
    ].join('\n'),
  );
}

/** A carton (juice, cream, coconut milk) with a picture of what is inside. */
export function carton(color: string, top: string, sign = ''): string {
  return svg(
    [
      `<path d="M9 11l3-5h8l3 5v17.5c0 .8-.7 1.5-1.5 1.5h-11C9.7 30 9 29.3 9 28.5z" fill="${color}"/>`,
      `<path d="M12 6h8l3 5H9z" fill="${top}"/>`,
      `<rect x="12" y="3" width="8" height="3" rx=".5" fill="${top}"/>`,
      `<rect x="10.5" y="14" width="11" height="12" rx="1.5" fill="#FFFFFF"/>`,
      sign,
    ].join('\n'),
  );
}

/** A sack of flour or grain, open at the top so what is inside shows, with a sign. */
export function sack(cloth: string, inside: string, sign = '', grainy = false): string {
  const grains = grainy
    ? scatter(14, 7, [10, 5.2, 22, 8.2])
        .map(
          (g) =>
            `<circle cx="${f(g.x)}" cy="${f(g.y)}" r=".45" fill="#000000" fill-opacity=".18"/>`,
        )
        .join('')
    : '';
  return svg(
    [
      `<path d="M7.5 10c0-2 2-3.5 4-3.5h9c2 0 4 1.5 4 3.5l1.5 15.5c.3 2.6-1.7 4.5-4.2 4.5H10.2c-2.5 0-4.5-1.9-4.2-4.5z" fill="${cloth}"/>`,
      `<ellipse cx="16" cy="7" rx="7.5" ry="2.6" fill="${inside}"/>`,
      grains,
      `<path d="M8.5 9.5c2 1.3 4.6 2 7.5 2s5.5-.7 7.5-2" stroke="#000000" stroke-opacity=".15" stroke-width="1"/>`,
      sign,
    ].join('\n'),
  );
}

/** A heap of powder (turmeric, chilli, sugar) on a small plate, with something beside it. */
export function heap(color: string, shade: string, beside = '', speck?: string): string {
  const specks = speck
    ? scatter(16, 3, [9, 15, 23, 24])
        .map((g) => `<circle cx="${f(g.x)}" cy="${f(g.y)}" r=".5" fill="${speck}"/>`)
        .join('')
    : '';
  return svg(
    [
      '<g transform="translate(-3.2 -6) scale(1.2)">',
      '<ellipse cx="16" cy="25.5" rx="12.5" ry="3.5" fill="#D3D3D3"/>',
      '<ellipse cx="16" cy="24.8" rx="11" ry="2.6" fill="#F4F4F4"/>',
      `<path d="M5.5 24.5c1.5-6 5.5-12 10.5-12s9 6 10.5 12c-3 1.4-6.6 2-10.5 2s-7.5-.6-10.5-2z" fill="${color}"/>`,
      `<path d="M16 12.5c-2.5 0-4.8 1.5-6.6 3.8 1.5-.6 3-.8 4.4-.4C15 16.3 16 14.5 16 12.5z" fill="${shade}" fill-opacity=".9"/>`,
      `<path d="M20 17c2 2 3.6 4.6 4.6 7.6" stroke="${shade}" stroke-width="1.2" stroke-linecap="round"/>`,
      specks,
      beside,
      '</g>',
    ].join('\n'),
  );
}

/** A bowl holding something: dal, curd, chutney, a masala paste. */
export function bowl(fill: string, rim: string, top = ''): string {
  return svg(
    [
      `<ellipse cx="16" cy="14.5" rx="12.5" ry="3.8" fill="${fill}"/>`,
      top,
      `<path d="M3.5 14.5h25c0 7.5-5.6 13-12.5 13S3.5 22 3.5 14.5z" fill="${rim}"/>`,
      '<path d="M3.6 14.5c.9 1.6 6 2.8 12.4 2.8s11.5-1.2 12.4-2.8" stroke="#000000" stroke-opacity=".12" stroke-width="1"/>',
      '<path d="M7.5 19.5c1.2 2.4 3.2 4 5.6 4.8" stroke="#FFFFFF" stroke-opacity=".4" stroke-width="1.2" stroke-linecap="round"/>',
      '<rect x="11" y="26.5" width="10" height="2" rx="1" fill="' + rim + '"/>',
    ].join('\n'),
  );
}

/** Seeds or grains scattered: an oval seed with a ridge, or round ones. */
export function seeds(
  n: number,
  color: string,
  edge: string,
  kind: 'oval' | 'round' | 'grain' | 'split' | 'cube' | 'flake',
  size = 1,
  seed = 1,
): string {
  const parts = scatter(n, seed, [5, 6, 27, 27]).map(({ x, y, r }) => {
    const t = `transform="rotate(${f(r)} ${f(x)} ${f(y)})"`;
    if (kind === 'round') {
      return `<circle cx="${f(x)}" cy="${f(y)}" r="${f(1.3 * size)}" fill="${color}" stroke="${edge}" stroke-width=".5"/><circle cx="${f(x - 0.4 * size)}" cy="${f(y - 0.4 * size)}" r="${f(0.35 * size)}" fill="#FFFFFF" fill-opacity=".45"/>`;
    }
    if (kind === 'grain') {
      return `<ellipse cx="${f(x)}" cy="${f(y)}" rx="${f(0.9 * size)}" ry="${f(2.3 * size)}" fill="${color}" stroke="${edge}" stroke-width=".4" ${t}/>`;
    }
    if (kind === 'split') {
      return `<ellipse cx="${f(x)}" cy="${f(y)}" rx="${f(1.7 * size)}" ry="${f(1.4 * size)}" fill="${color}" stroke="${edge}" stroke-width=".45" ${t}/><path d="M${f(x - 1.2 * size)} ${f(y)}h${f(2.4 * size)}" stroke="${edge}" stroke-width=".3" ${t}/>`;
    }
    if (kind === 'cube') {
      return `<rect x="${f(x - 0.9 * size)}" y="${f(y - 0.7 * size)}" width="${f(1.8 * size)}" height="${f(1.4 * size)}" rx=".3" fill="${color}" stroke="${edge}" stroke-width=".35" ${t}/>`;
    }
    if (kind === 'flake') {
      return `<path d="M${f(x - 2 * size)} ${f(y)}q${f(2 * size)} ${f(-1.6 * size)} ${f(4 * size)} 0q${f(-2 * size)} ${f(1.4 * size)} ${f(-4 * size)} 0z" fill="${color}" stroke="${edge}" stroke-width=".35" ${t}/>`;
    }
    return `<g ${t}><ellipse cx="${f(x)}" cy="${f(y)}" rx="${f(1 * size)}" ry="${f(2.8 * size)}" fill="${color}" stroke="${edge}" stroke-width=".45"/><path d="M${f(x)} ${f(y - 2.4 * size)}v${f(4.8 * size)}" stroke="${edge}" stroke-width=".35"/></g>`;
  });
  return svg(parts.join('\n'));
}

/** A folded stack of cloth: towels, sheets. */
export function cloth(color: string, edge: string, stripe?: string, layers = 3): string {
  const out: string[] = [];
  for (let i = 0; i < layers; i++) {
    const y = 24 - i * 6;
    out.push(
      `<rect x="4" y="${y}" width="24" height="6" rx="2.2" fill="${color}" stroke="${edge}" stroke-width=".8"/>`,
    );
    out.push(
      `<path d="M6.5 ${y + 3}h19" stroke="${edge}" stroke-opacity=".5" stroke-width=".7" stroke-dasharray="1.2 1"/>`,
    );
    if (stripe) out.push(`<rect x="21" y="${y}" width="2.4" height="6" fill="${stripe}"/>`);
  }
  return svg(out.join('\n'));
}

/** A trigger spray bottle (glass cleaner, sanitiser). */
export function spray(body: string, liquid: string, sign = ''): string {
  return svg(
    [
      `<path d="M11 13c0-1.7 1.3-3 3-3h4c1.7 0 3 1.3 3 3v14.5c0 1.4-1.1 2.5-2.5 2.5h-5c-1.4 0-2.5-1.1-2.5-2.5z" fill="${body}"/>`,
      `<path d="M11 18h10v9.5c0 1.4-1.1 2.5-2.5 2.5h-5c-1.4 0-2.5-1.1-2.5-2.5z" fill="${liquid}"/>`,
      '<rect x="13.5" y="7" width="5" height="3.5" fill="#636363"/>',
      '<path d="M11.5 3.5h9.5l2.5 3H11.5z" fill="#4A4A4A"/>',
      '<path d="M20 7.5l-1.5 4" stroke="#4A4A4A" stroke-width="1.6" stroke-linecap="round"/>',
      sign,
      '<path d="M13 14v3" stroke="#FFFFFF" stroke-opacity=".5" stroke-width="1.2" stroke-linecap="round"/>',
    ].join('\n'),
  );
}

/** A jug with a handle (floor cleaner, detergent, dish wash). */
export function jug(body: string, cap: string, sign = ''): string {
  return svg(
    [
      `<path d="M9 12c0-2.2 1.8-4 4-4h6c2.2 0 4 1.8 4 4v15.5c0 1.4-1.1 2.5-2.5 2.5h-9C10.1 30 9 28.9 9 27.5z" fill="${body}"/>`,
      `<path d="M20.5 9.5h3.2c1.3 0 2.3 1 2.3 2.3v4.4c0 1.3-1 2.3-2.3 2.3H23" stroke="${body}" stroke-width="2.4"/>`,
      `<rect x="12" y="4" width="6" height="4.5" rx="1" fill="${cap}"/>`,
      '<rect x="10.5" y="15" width="11" height="10" rx="1.5" fill="#FFFFFF"/>',
      sign,
    ].join('\n'),
  );
}

/** A roll (foil, cling film, bags) with its sheet pulled out. */
export function roll(color: string, edge: string, sheet: string): string {
  return svg(
    [
      `<path d="M6 21l18-9 3 6-18 9z" fill="${sheet}" fill-opacity=".9"/>`,
      `<rect x="4" y="9" width="21" height="9" rx="4.5" fill="${color}" transform="rotate(-25 14.5 13.5)"/>`,
      `<ellipse cx="23.6" cy="9.1" rx="3" ry="4.5" fill="${edge}" transform="rotate(-25 23.6 9.1)"/>`,
      '<ellipse cx="23.6" cy="9.1" rx="1.2" ry="1.8" fill="#7D4533" transform="rotate(-25 23.6 9.1)"/>',
      '<path d="M7.5 15.5l14-6.5" stroke="#FFFFFF" stroke-opacity=".55" stroke-width="1.2" stroke-linecap="round"/>',
    ].join('\n'),
  );
}

/** A glass jar with a lid, holding something. */
export function jar(content: string, lid: string, top = '', sign = ''): string {
  return svg(
    [
      `<rect x="7.5" y="9" width="17" height="20" rx="3.5" fill="#D9F0FF" fill-opacity=".7"/>`,
      `<rect x="8.5" y="12" width="15" height="16" rx="2.5" fill="${content}"/>`,
      top,
      `<rect x="7" y="4.5" width="18" height="5" rx="1.2" fill="${lid}"/>`,
      '<path d="M9.5 6.5h13" stroke="#000000" stroke-opacity=".15" stroke-width=".8"/>',
      sign,
      '<path d="M10.5 14v6" stroke="#FFFFFF" stroke-opacity=".55" stroke-width="1.3" stroke-linecap="round"/>',
    ].join('\n'),
  );
}

/** A small sign drawn inside a 32 x 32 picture at a position and scale. */
export const at = (x: number, y: number, s: number, body: string) =>
  `<g transform="translate(${x} ${y}) scale(${s})">${body}</g>`;

/**
 * A heap of seeds or grains on a plate, with big ones in front so their shape shows:
 * cumin is long and ridged, mustard round and black, dal split and yellow.
 */
export function grainHeap(
  heapColor: string,
  heapShade: string,
  grain: (x: number, y: number, r: number, size: number) => string,
  seed = 1,
): string {
  const texture = scatter(26, seed, [8, 15, 24, 23])
    .filter((g) => (g.x - 16) ** 2 / 64 + (g.y - 21) ** 2 / 36 <= 1)
    .map((g) => grain(g.x, g.y, g.r, 0.62))
    .join('');
  const front = [
    [8.5, 26.5, 20],
    [13.5, 27.5, -35],
    [18.5, 27.5, 60],
    [23.5, 26.5, -10],
    [11, 23.8, 75],
    [21, 23.8, 35],
  ]
    .map(([x, y, r]) => grain(x!, y!, r!, 1.15))
    .join('');
  return svg(
    [
      '<g transform="translate(-4 -7.6) scale(1.25)">',
      '<ellipse cx="16" cy="26.5" rx="12.6" ry="3.6" fill="#D3D3D3"/>',
      '<ellipse cx="16" cy="25.8" rx="11" ry="2.7" fill="#F4F4F4"/>',
      `<path d="M5 25.5c1.5-6.5 5.8-13 11-13s9.5 6.5 11 13c-3.2 1.5-7 2-11 2s-7.8-.5-11-2z" fill="${heapColor}"/>`,
      `<path d="M16 12.5c-2.7 0-5.1 1.6-7 4.1 1.6-.6 3.2-.8 4.7-.4 1.2-1.4 2.3-2.4 2.3-3.7z" fill="${heapShade}" fill-opacity=".6"/>`,
      texture,
      front,
      '</g>',
    ].join('\n'),
  );
}

// grains for grainHeap, each at (x, y), turned r degrees, scaled by size
const t = (n: number) => Number(n.toFixed(2));
export const GRAIN = {
  oval: (fill: string, edge: string) => (x: number, y: number, r: number, s: number) =>
    `<g transform="translate(${t(x)} ${t(y)}) rotate(${t(r)}) scale(${s})"><ellipse rx="1.05" ry="2.9" fill="${fill}" stroke="${edge}" stroke-width=".45"/><path d="M0 -2.5v5" stroke="${edge}" stroke-width=".4"/></g>`,
  rice: (fill: string, edge: string) => (x: number, y: number, r: number, s: number) =>
    `<g transform="translate(${t(x)} ${t(y)}) rotate(${t(r)}) scale(${s})"><ellipse rx="1" ry="2.6" fill="${fill}" stroke="${edge}" stroke-width=".4"/></g>`,
  round: (fill: string, edge: string) => (x: number, y: number, _r: number, s: number) =>
    `<g transform="translate(${t(x)} ${t(y)}) scale(${s})"><circle r="1.35" fill="${fill}" stroke="${edge}" stroke-width=".45"/><circle cx="-.45" cy="-.45" r=".38" fill="#FFFFFF" fill-opacity=".45"/></g>`,
  split: (fill: string, edge: string) => (x: number, y: number, r: number, s: number) =>
    `<g transform="translate(${t(x)} ${t(y)}) rotate(${t(r)}) scale(${s})"><ellipse rx="1.8" ry="1.45" fill="${fill}" stroke="${edge}" stroke-width=".45"/><path d="M-1.2 0h2.4" stroke="${edge}" stroke-width=".3"/></g>`,
  bean:
    (fill: string, edge: string, eye?: string) => (x: number, y: number, r: number, s: number) =>
      `<g transform="translate(${t(x)} ${t(y)}) rotate(${t(r)}) scale(${s})"><ellipse rx="1.35" ry="1.8" fill="${fill}" stroke="${edge}" stroke-width=".45"/>${eye ? `<ellipse cx=".9" rx=".3" ry=".7" fill="${eye}"/>` : ''}</g>`,
  cube: (fill: string, edge: string) => (x: number, y: number, r: number, s: number) =>
    `<g transform="translate(${t(x)} ${t(y)}) rotate(${t(r)}) scale(${s})"><rect x="-1" y="-.8" width="2" height="1.6" rx=".3" fill="${fill}" stroke="${edge}" stroke-width=".35"/></g>`,
  flake: (fill: string, edge: string) => (x: number, y: number, r: number, s: number) =>
    `<g transform="translate(${t(x)} ${t(y)}) rotate(${t(r)}) scale(${s})"><path d="M-2.2 0q2.2-1.8 4.4 0q-2.2 1.6-4.4 0z" fill="${fill}" stroke="${edge}" stroke-width=".35"/></g>`,
  pepper: (fill: string, edge: string) => (x: number, y: number, _r: number, s: number) =>
    `<g transform="translate(${t(x)} ${t(y)}) scale(${s})"><circle r="1.7" fill="${fill}"/><path d="M-1 -.4q1 .8 2 0M-.9 .8q.9 .6 1.8 0" stroke="${edge}" stroke-width=".45" fill="none"/><circle cx="-.6" cy="-.8" r=".45" fill="#FFFFFF" fill-opacity=".35"/></g>`,
};
