// The drawn pictures (ADR 084), one per key that Fluent Emoji does not have. `fl` embeds a
// Fluent picture (by key) inside a drawn one, for the category pictures and a few signs.

import {
  at,
  bottle,
  bowl,
  can,
  carton,
  cloth,
  GRAIN,
  grainHeap,
  heap,
  jar,
  jug,
  roll,
  sack,
  scatter,
  spray,
  svg,
} from './shapes';

type Fl = (key: string, x: number, y: number, size: number) => string;

const f = (n: number) => Number(n.toFixed(2));

// small signs, drawn in 32 x 32 units and placed with at()
const CHILLI =
  '<path d="M9 24c6-1 13-6 15-14 .5-2-1.5-3.2-3-2-1.5 6-6 11-12 13-1.5.5-1.5 3.2 0 3z" fill="#F8312F"/><path d="M21 8.5c.2-2 1.4-3.3 3-3.8" stroke="#00A35C" stroke-width="1.6" stroke-linecap="round"/><path d="M19.5 9c1.2-1.4 3.6-1.6 5-.4" stroke="#00A35C" stroke-width="2" stroke-linecap="round"/>';
const WHEAT =
  '<path d="M16 29V9" stroke="#C68A36" stroke-width="1.4"/>' +
  [11, 15, 19, 23]
    .map(
      (y) =>
        `<ellipse cx="13.4" cy="${y}" rx="1.6" ry="2.6" fill="#E8B04B" transform="rotate(-35 13.4 ${y})"/><ellipse cx="18.6" cy="${y}" rx="1.6" ry="2.6" fill="#E8B04B" transform="rotate(35 18.6 ${y})"/>`,
    )
    .join('') +
  '<ellipse cx="16" cy="7.5" rx="1.5" ry="2.6" fill="#E8B04B"/>';
const COCONUT =
  '<circle cx="16" cy="17" r="10" fill="#7D4533"/><circle cx="16" cy="17" r="7.5" fill="#FFFFFF"/><circle cx="16" cy="17" r="5.5" fill="#F4F4F4"/>';
const LEAF =
  '<path d="M6 26C6 14 14 6 27 5c0 13-8 21-21 21z" fill="#00D26A"/><path d="M7 25L22 10" stroke="#008463" stroke-width="1.2" stroke-linecap="round"/>';
const SNOW =
  '<g stroke="#00A6ED" stroke-width="1.8" stroke-linecap="round"><path d="M16 5v22M6.5 10.5l19 11M6.5 21.5l19-11"/><path d="M13 7l3 3 3-3M13 25l3-3 3 3"/></g>';
const JUNIPER =
  '<circle cx="12" cy="18" r="3.4" fill="#5B5EC6"/><circle cx="19" cy="15" r="3.4" fill="#4A4DB0"/><circle cx="18" cy="22" r="3.4" fill="#6366D9"/><path d="M14 11c2-3 5-4 8-3" stroke="#00A35C" stroke-width="1.3" stroke-linecap="round"/>';
const AGAVE =
  '<g fill="#00A35C"><path d="M16 27L13 9l3-3 3 3z"/><path d="M15 27L5 14l2-2 10 12z"/><path d="M17 27L27 14l-2-2-10 12z"/></g><path d="M8 27h16" stroke="#7D4533" stroke-width="1.6" stroke-linecap="round"/>';
const PALM =
  '<path d="M16 28c0-6 .5-12 2-17" stroke="#A56953" stroke-width="2" stroke-linecap="round"/><g fill="#00D26A"><path d="M18 10C14 6 9 7 6 10c4 0 8 0 12 0z"/><path d="M18 10c4-4 9-3 11 1-4-1-7-1-11-1z"/><path d="M18 10c-2-4-2-7 0-9 2 3 2 6 0 9z"/><path d="M18 10c-5 1-8 4-8 8 3-3 5-6 8-8z"/><path d="M18 10c5 1 8 4 8 8-3-3-5-6-8-8z"/></g>';
const CASHEW_APPLE =
  '<path d="M11 6c4-1 9 1 10 6s-2 9-5 10-6-2-6-6c0-3 0-8 1-10z" fill="#FF822D"/><path d="M16 22c-2 4 0 7 3 7s5-3 3-6c-1-1.5-3-2-6-1z" fill="#C79D72"/><path d="M14 6c0-2 1-3 2-3" stroke="#00A35C" stroke-width="1.4" stroke-linecap="round"/>';
const ORANGE_SLICE =
  '<circle cx="16" cy="16" r="11" fill="#FF822D"/><circle cx="16" cy="16" r="9" fill="#FFB02E"/>' +
  [0, 60, 120, 180, 240, 300]
    .map(
      (a) =>
        `<path d="M16 16l0-8.5" stroke="#FFDA6B" stroke-width="1.2" transform="rotate(${a} 16 16)"/>`,
    )
    .join('') +
  '<circle cx="16" cy="16" r="1.4" fill="#FFDA6B"/>';
const BERRIES =
  '<circle cx="11" cy="18" r="5" fill="#CA0B4A"/><circle cx="20" cy="14" r="5" fill="#E0115F"/><circle cx="19" cy="23" r="5" fill="#B0093F"/><circle cx="9.5" cy="16.5" r="1.2" fill="#FFFFFF" fill-opacity=".5"/><circle cx="18.5" cy="12.5" r="1.2" fill="#FFFFFF" fill-opacity=".5"/>';
const COFFEE_BEAN = (x: number, y: number, r: number) =>
  `<g transform="rotate(${r} ${x} ${y})"><ellipse cx="${x}" cy="${y}" rx="3.4" ry="4.6" fill="#6D4534"/><path d="M${x} ${y - 4}c-1.4 2 1.4 4 0 8" stroke="#3F2A20" stroke-width="1"/></g>`;
const CLOVE = (x: number, y: number, r: number, s = 1) =>
  `<g transform="translate(${x} ${y}) rotate(${r}) scale(${s})"><path d="M-.9 -3h1.8l-.4 11.5c-.1.7-.9.7-1 0z" fill="#7A3E1D"/><path d="M-3 -3.5c1-1.4 5-1.4 6 0l-1 2.4c-1.2.8-2.8.8-4 0z" fill="#5A2E15"/><circle cx="0" cy="-5.2" r="2.2" fill="#8B4A24"/><circle cx="-.6" cy="-5.8" r=".7" fill="#B06A3E"/></g>`;
const CARDAMOM = (x: number, y: number, r: number, c = '#8DB33A', e = '#5E7E1F') =>
  `<g transform="rotate(${r} ${x} ${y})"><ellipse cx="${x}" cy="${y}" rx="2.6" ry="4.6" fill="${c}" stroke="${e}" stroke-width=".6"/><path d="M${x} ${y - 4}v8M${x - 1.3} ${y - 3.3}c-.6 2-.6 4.6 0 6.6M${x + 1.3} ${y - 3.3}c.6 2 .6 4.6 0 6.6" stroke="${e}" stroke-width=".45"/><path d="M${x} ${y - 4.6}l0 -1.4" stroke="${e}" stroke-width=".9" stroke-linecap="round"/></g>`;
const STAR = (x: number, y: number, r = 7) => {
  const pts: string[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI * 2 * i) / 8;
    pts.push(
      `<ellipse cx="${f(x + Math.cos(a) * r * 0.55)}" cy="${f(y + Math.sin(a) * r * 0.55)}" rx="${f(r * 0.5)}" ry="${f(r * 0.24)}" fill="#8B3E1E" transform="rotate(${f((a * 180) / Math.PI)} ${f(x + Math.cos(a) * r * 0.55)} ${f(y + Math.sin(a) * r * 0.55)})"/>`,
    );
    pts.push(
      `<circle cx="${f(x + Math.cos(a) * r * 0.62)}" cy="${f(y + Math.sin(a) * r * 0.62)}" r="${f(r * 0.1)}" fill="#D9A066"/>`,
    );
  }
  return pts.join('') + `<circle cx="${x}" cy="${y}" r="${f(r * 0.16)}" fill="#5A2410"/>`;
};
const LABEL_TEXT = (t: string, color: string, y = 16) =>
  `<text x="16" y="${y + 1.6}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="4.6" fill="${color}">${t}</text>`;

export function drawn(fl: Fl): Record<string, string> {
  return {
    // vegetables
    'spring-onion': svg(
      '<path d="M9 28c1-8 2-15 1-24M13 28c0-8 1-16 3-24M17 28c0-8 2-14 5-22" stroke="#00D26A" stroke-width="2.6" stroke-linecap="round"/><path d="M8 20h12" stroke="#00A35C" stroke-width=".8"/><ellipse cx="12" cy="27" rx="6" ry="3" fill="#F4F4F4"/><path d="M8 29.5l-1 1.5M12 30l0 1.5M16 29.5l1 1.5" stroke="#C7B9A6" stroke-width=".8" stroke-linecap="round"/>',
    ),
    cauliflower: svg(
      '<path d="M4 18c2 6 7 10 12 10s10-4 12-10c-4 1-8 2-12 2s-8-1-12-2z" fill="#44911B"/><path d="M4 18c-1-4 2-6 4-5-1-3 3-5 5-3 1-3 5-3 6 0 2-2 6 0 5 3 2-1 5 1 4 5-4 1.5-8 2-12 2s-8-.5-12-2z" fill="#FFF7E0"/>' +
        scatter(12, 4, [7, 11, 25, 17])
          .map((g) => `<circle cx="${f(g.x)}" cy="${f(g.y)}" r="1.5" fill="#F1E2B8"/>`)
          .join('') +
        '<path d="M8 22c2 2 5 3 8 3" stroke="#00A35C" stroke-width="1" stroke-linecap="round"/>',
    ),
    cabbage: svg(
      '<circle cx="16" cy="17" r="12" fill="#86D72F"/><path d="M16 5c-6 3-8 8-8 12s3 9 8 12M16 5c6 3 8 8 8 12s-3 9-8 12" stroke="#5E9E1F" stroke-width="1.2" fill="none"/><path d="M16 9c-3 2-4 5-4 8s1.5 6 4 8M16 9c3 2 4 5 4 8s-1.5 6-4 8" stroke="#5E9E1F" stroke-width="1" fill="none"/><path d="M16 6v22" stroke="#C3EF3C" stroke-width="1.2"/>',
    ),
    'green-beans': svg(
      [
        [5, 27, 22, 6, 0],
        [8, 29, 27, 10, 0],
        [4, 21, 18, 4, 0],
      ]
        .map(
          ([x1, y1, x2, y2]) =>
            `<path d="M${x1} ${y1}C${(x1! + x2!) / 2 - 2} ${(y1! + y2!) / 2 + 2} ${(x1! + x2!) / 2 + 2} ${(y1! + y2!) / 2 - 2} ${x2} ${y2}" stroke="#44911B" stroke-width="3.2" stroke-linecap="round"/><path d="M${x1} ${y1}C${(x1! + x2!) / 2 - 2} ${(y1! + y2!) / 2 + 2} ${(x1! + x2!) / 2 + 2} ${(y1! + y2!) / 2 - 2} ${x2} ${y2}" stroke="#86D72F" stroke-width="1.6" stroke-linecap="round"/>`,
        )
        .join(''),
    ),
    okra: svg(
      '<g transform="rotate(-35 16 16)"><path d="M16 4c3 0 4 2 4 5l-1.5 16c-.3 2.5-1.3 4-2.5 4s-2.2-1.5-2.5-4L12 9c0-3 1-5 4-5z" fill="#5E9E1F"/><path d="M14.3 8l1 18M17.7 8l-1 18M16 6v22" stroke="#86D72F" stroke-width=".9"/><path d="M14 4.5h4l-.5-2.5h-3z" fill="#3F7A12"/></g><g transform="rotate(20 22 18)"><path d="M22 8c2.4 0 3.2 1.6 3.2 4l-1.2 12c-.2 2-1 3.2-2 3.2s-1.8-1.2-2-3.2l-1.2-12c0-2.4.8-4 3.2-4z" fill="#44911B"/><path d="M22 10v15M20.6 11l.8 13M23.4 11l-.8 13" stroke="#86D72F" stroke-width=".8"/></g>',
    ),
    pumpkin: svg(
      '<ellipse cx="16" cy="19" rx="13" ry="10" fill="#FF822D"/><ellipse cx="16" cy="19" rx="7" ry="10" fill="#FF9F2E"/><path d="M9 10c-3 3-3 15 0 18M23 10c3 3 3 15 0 18M16 9v20" stroke="#D96B1F" stroke-width="1.1" fill="none"/><path d="M16 9c0-3 1-5 3-6" stroke="#44911B" stroke-width="2.2" stroke-linecap="round"/>',
    ),
    beetroot: svg(
      '<path d="M16 12c6 0 9 4 9 8s-4 7-9 10c-5-3-9-6-9-10s3-8 9-8z" fill="#9B1B4A"/><path d="M16 30l.5 2" stroke="#9B1B4A" stroke-width="1.2" stroke-linecap="round"/><path d="M12 12C9 6 10 3 12 2c2 2 2 6 1 10M16 12c0-5 1-9 3-10 2 2 0 7-2 10M19 12c2-4 5-6 8-5-1 3-4 5-7 6" fill="#44911B"/><path d="M12 12L11 4M16 12l2-9M19 12l6-4" stroke="#CA0B4A" stroke-width=".8"/><path d="M11 18c1 3 3 5 5 6" stroke="#D63F72" stroke-width="1" stroke-linecap="round"/>',
    ),
    radish: svg(
      '<path d="M12 11c-1 6 0 14 4 19 4-5 5-13 4-19-1.5-1-6.5-1-8 0z" fill="#F4F4F4" stroke="#D3D3D3" stroke-width=".6"/><path d="M14 16h3M14.5 21h2.5" stroke="#D3D3D3" stroke-width=".7" stroke-linecap="round"/><path d="M12 11C8 7 8 3 10 2c3 1 4 5 4 9M16 11c-1-4 0-8 3-9 2 2 1 6-1 9M18 11c2-3 5-4 8-3-1 2-4 4-7 4" fill="#00D26A"/>',
    ),

    // the chillies: Fluent's red chilli, green; and dried, darker and wrinkled
    'green-chilli': svg(
      '<path d="M5.5 25.5c7.5-1 14.5-6 18-14 .9-2.2-1.3-4-3.2-2.6-2.5 6.5-7.8 11.3-14.8 13-1.8.4-1.7 3.8 0 3.6z" fill="#44911B"/><path d="M7 23.8c6.5-1.6 11.5-5.6 14.4-11.6" stroke="#86D72F" stroke-width="1.1" stroke-linecap="round"/><path d="M21 9.8c.4-2.6 1.8-4.2 3.8-4.8" stroke="#3F7A12" stroke-width="1.8" stroke-linecap="round"/><path d="M19.6 10.2c1.4-1.8 4-2 5.6-.6" stroke="#3F7A12" stroke-width="2.2" stroke-linecap="round"/>' +
        '<path d="M10 29.5c5.5-.8 11-4.6 13.5-10.5.6-1.6-1-3-2.4-2-1.8 4.8-5.7 8.3-11 9.6-1.3.3-1.3 3 0 2.9z" fill="#5E9E1F"/>',
    ),
    'dried-red-chilli': svg(
      [
        [11, 15, -40],
        [21, 14, 35],
        [16, 21, 5],
      ]
        .map(
          ([x, y, r]) =>
            `<g transform="translate(${x} ${y}) rotate(${r})"><path d="M-2.6 -8.5c1.6-.9 3.6-.9 5.2 0 .6 5.2.4 10.4-1 15-.5 1.6-2.7 1.6-3.2 0-1.4-4.6-1.6-9.8-1-15z" fill="#C0161F"/><path d="M-1.5 -5.5l.6 3.2M1 -4l-.6 3.4M-1.2 1l.5 3M1 2.6l-.4 2.4" stroke="#7E0B12" stroke-width=".7" stroke-linecap="round"/><path d="M-.8 -7c.3 4 .3 9 0 12" stroke="#E8505A" stroke-width=".8" stroke-linecap="round"/><path d="M0 -8.8c0-1.8.9-3 2.4-3.7" stroke="#6E7A2E" stroke-width="1.5" stroke-linecap="round"/></g>`,
        )
        .join(''),
    ),

    // herbs
    'coriander-leaves': svg(
      '<path d="M16 30V14M16 22l-6-8M16 19l6-7M16 26l-8-4M16 25l8-3" stroke="#00A35C" stroke-width="1.1" stroke-linecap="round"/>' +
        [
          [16, 10],
          [9, 11],
          [23, 9],
          [7, 20],
          [25, 19],
          [12, 6],
          [20, 5],
        ]
          .map(
            ([x, y]) =>
              `<g transform="translate(${x} ${y})"><path d="M0 -4c2 0 3 1.4 3.6 3 1 .2 1.4 1.4.6 2.2.6 1-.2 2.4-1.4 2.2C2 4.8.8 5 0 4.2c-.8.8-2 .6-2.8-.8-1.2.2-2-1.2-1.4-2.2-.8-.8-.4-2 .6-2.2C-3 -2.6-2-4 0-4z" fill="#00D26A"/><path d="M0 4V-1.5M0 1.5l-2-2M0 1.5l2-2" stroke="#00A35C" stroke-width=".5"/></g>`,
          )
          .join(''),
    ),
    mint: svg(
      '<path d="M16 30V6" stroke="#5E9E1F" stroke-width="1.4" stroke-linecap="round"/>' +
        [
          [10, 23, -40],
          [22, 23, 40],
          [10.5, 15, -35],
          [21.5, 15, 35],
          [12, 8, -20],
          [20, 8, 20],
        ]
          .map(
            ([x, y, r]) =>
              `<g transform="translate(${x} ${y}) rotate(${r})"><path d="M0 -5.5c3 1 4.4 3.4 4 6-.4 2.4-2 4-4 4.6-2-.6-3.6-2.2-4-4.6-.4-2.6 1-5 4-6z" fill="#00D26A"/><path d="M-3.7 -1l-.6.6.8.4-.6.8.9.3M3.7 -1l.6.6-.8.4.6.8-.9.3" stroke="#00A35C" stroke-width=".5" fill="none"/><path d="M0 -4.5v8.5M0 -1l-2-1.6M0 -1l2-1.6M0 2l-2.2-1.4M0 2l2.2-1.4" stroke="#00A35C" stroke-width=".55"/></g>`,
          )
          .join(''),
    ),
    'curry-leaves': svg(
      '<path d="M6 28C11 20 18 11 27 4" stroke="#5E9E1F" stroke-width="1.3" stroke-linecap="round"/>' +
        [
          [9, 25, 1],
          [12, 21, 1],
          [15.5, 17, 1],
          [19, 13, 1],
          [22.5, 9, 1],
        ]
          .flatMap(([x, y]) => [
            `<g transform="translate(${x! - 3} ${y! - 3}) rotate(-20)"><path d="M0 0c-3-.4-5-2-5.5-4.4 2.4-.6 4.6.6 5.5 4.4z" fill="#44911B"/></g>`,
            `<g transform="translate(${x! + 3} ${y! + 2.5}) rotate(20)"><path d="M0 0c3 .2 5 1.8 5.6 4.2-2.4.6-4.6-.6-5.6-4.2z" fill="#44911B"/></g>`,
          ])
          .join('') +
        '<path d="M25.5 5.5c-.2-2 .8-3.6 2.8-4.2.4 2-.6 3.6-2.8 4.2z" fill="#44911B"/>',
    ),
    lemongrass: svg(
      '<path d="M9 30l3-22M14 30l1-24M19 30l-1-22M23 30l-3-20" stroke="#B5D96E" stroke-width="2.6" stroke-linecap="round"/><path d="M8.5 30l.8-6M13.6 30l.3-6M19 30l-.4-6M23 30l-.9-6" stroke="#F4F4F4" stroke-width="2.8" stroke-linecap="round"/><path d="M12 8c-2-3-3-5-3-6M15 6c0-2 1-4 2-5M18 8c2-2 4-4 6-4" stroke="#86D72F" stroke-width="1.4" stroke-linecap="round"/>',
    ),
    rose: svg(
      [
        [10, 12, 0],
        [21, 10, 40],
        [12, 22, -30],
        [22, 21, 70],
        [16, 16, 15],
      ]
        .map(
          ([x, y, r]) =>
            `<g transform="translate(${x} ${y}) rotate(${r})"><path d="M0 -5c3.4 0 5 2.4 4.6 5S2 5 0 5s-5-2.4-4.6-5S-3.4-5 0-5z" fill="#F92F60"/><path d="M-3 0c1 1.6 2.4 2.6 4.4 2.6" stroke="#CA0B4A" stroke-width=".7" stroke-linecap="round"/></g>`,
        )
        .join(''),
    ),

    // fruit
    pomegranate: svg(
      '<circle cx="16" cy="18" r="11" fill="#CA0B4A"/><path d="M12 7.5l1.2-3 1.6 2 1.2-3 1.2 3 1.6-2 1.2 3z" fill="#9B0A3A"/><path d="M16 18a7 7 0 0 1 7 4l-7 0z" fill="#FFB2C1"/>' +
        scatter(10, 9, [17, 19, 22, 22])
          .map((g) => `<circle cx="${f(g.x)}" cy="${f(g.y)}" r=".9" fill="#E0115F"/>`)
          .join('') +
        '<circle cx="11" cy="14" r="2" fill="#FFFFFF" fill-opacity=".3"/>',
    ),
    papaya: svg(
      '<path d="M6 19c0-7 5-14 10-14s10 7 10 14-4 10-10 10S6 26 6 19z" fill="#86D72F"/><path d="M8 19c0-6 4-11.5 8-11.5s8 5.5 8 11.5-3.6 8-8 8-8-2-8-8z" fill="#FF822D"/><ellipse cx="16" cy="19" rx="3.4" ry="6" fill="#FFB02E"/>' +
        scatter(10, 5, [14, 15, 18, 23])
          .map((g) => `<circle cx="${f(g.x)}" cy="${f(g.y)}" r=".8" fill="#3F2A20"/>`)
          .join(''),
    ),
    guava: svg(
      '<circle cx="15" cy="18" r="11" fill="#86D72F"/><path d="M15 18a11 11 0 0 1 11 0 11 11 0 0 1-11 11z" fill="#FF97A6"/><circle cx="21" cy="22" r="1" fill="#F4F4F4"/><circle cx="19" cy="25" r="1" fill="#F4F4F4"/><path d="M15 7c0-2 1-4 3-5" stroke="#7D4533" stroke-width="1.4" stroke-linecap="round"/><path d="M17 4c2-2 5-2 7 0-2 1.5-5 1.5-7 0z" fill="#00A35C"/>',
    ),
    jackfruit: svg(
      '<ellipse cx="16" cy="17" rx="10" ry="13" fill="#B5C730"/>' +
        scatter(40, 2, [7, 5, 25, 29])
          .map((g) => `<path d="M${f(g.x)} ${f(g.y - 0.8)}l.8 1.4h-1.6z" fill="#7E8B1C"/>`)
          .join('') +
        '<path d="M16 4V1" stroke="#7D4533" stroke-width="1.6" stroke-linecap="round"/>',
    ),
    'tender-coconut': svg(
      '<path d="M5 18c0-7 5-13 11-13s11 6 11 13-5 11-11 11S5 25 5 18z" fill="#44911B"/><path d="M8 18c0-5.5 3.5-10 8-10" stroke="#86D72F" stroke-width="1.4" stroke-linecap="round"/><ellipse cx="16" cy="7" rx="5" ry="2" fill="#F4F4F4"/><path d="M19 7l2-6" stroke="#FFB02E" stroke-width="1.6" stroke-linecap="round"/><path d="M21 1h3" stroke="#F8312F" stroke-width="1.6" stroke-linecap="round"/>',
    ),
    cranberry: svg(BERRIES),

    // spices
    cumin: grainHeap('#B8956A', '#8C6B42', GRAIN.oval('#A88457', '#6E5230'), 11),
    clove: svg(
      [
        [9, 14, -30],
        [17, 10, 15],
        [23, 17, 60],
        [12, 23, -70],
        [20, 24, 30],
      ]
        .map(([x, y, r]) => CLOVE(x!, y!, r!, 1.05))
        .join(''),
    ),
    cinnamon: svg(
      '<g transform="rotate(-35 16 16)"><rect x="3" y="11" width="26" height="7" rx="1.5" fill="#A0522D"/><rect x="3" y="11" width="26" height="2.2" fill="#BF6F43"/><ellipse cx="29" cy="14.5" rx="1.9" ry="3.5" fill="#C47B4E"/><path d="M29 12c-1 1.6-1 3.6 0 5.2" stroke="#7A3A18" stroke-width=".8" fill="none"/></g>' +
        '<g transform="rotate(-20 16 22)"><rect x="5" y="19" width="22" height="6.4" rx="1.5" fill="#8B4513"/><rect x="5" y="19" width="22" height="2" fill="#A35A26"/><ellipse cx="27" cy="22.2" rx="1.8" ry="3.2" fill="#B5703F"/><path d="M27 19.8c-.9 1.4-.9 3.4 0 4.8" stroke="#6B3010" stroke-width=".8" fill="none"/></g>',
    ),
    cardamom: svg(
      CARDAMOM(10, 14, -30) +
        CARDAMOM(18, 11, 20) +
        CARDAMOM(22, 20, 70) +
        CARDAMOM(13, 22, -60) +
        CARDAMOM(17.5, 18.5, 5),
    ),
    'black-cardamom': svg(
      [
        [11, 13, -25],
        [20, 12, 25],
        [15, 21, 80],
      ]
        .map(
          ([x, y, r]) =>
            `<g transform="rotate(${r} ${x} ${y})"><ellipse cx="${x}" cy="${y}" rx="4" ry="6" fill="#4A3426"/><path d="M${x! - 2.6} ${y! - 3}q2.6 1 5.2 0M${x! - 3.2} ${y}q3.2 1 6.4 0M${x! - 2.6} ${y! + 3}q2.6 1 5.2 0" stroke="#2A1C13" stroke-width=".7" fill="none"/><path d="M${x} ${y! - 6}v-1.6" stroke="#6E5230" stroke-width="1" stroke-linecap="round"/></g>`,
        )
        .join(''),
    ),
    'black-pepper': grainHeap('#4A3A30', '#2A1C13', GRAIN.pepper('#3A2A22', '#1E1410'), 6),
    turmeric: heap(
      '#FFB02E',
      '#E08A00',
      '<g transform="translate(18 19) rotate(-20)"><path d="M0 0c2-1.4 6-1.4 8 0 .8.6.6 2-.4 2.2-2.4.6-5 .6-7.2 0-1-.2-1.2-1.6-.4-2.2z" fill="#C67F2A"/><path d="M3 -.6v2.6M5.6 -.4v2.4" stroke="#8A5214" stroke-width=".5"/><path d="M8 1c1.4 0 2.6.4 3 1.4" stroke="#C67F2A" stroke-width="1.6" stroke-linecap="round"/><circle cx="-.2" cy="1" r="1.2" fill="#FF822D"/></g>',
    ),
    'chilli-powder': heap('#D9261E', '#A3111E', at(14, 13, 0.55, CHILLI)),
    'coriander-powder': heap('#B8956A', '#8C6B42', ''),
    'coriander-seeds': grainHeap('#D2B27C', '#A07E48', GRAIN.round('#C9A66B', '#8C6B42'), 13),
    'garam-masala': heap(
      '#7D4E2C',
      '#5A3418',
      STAR(24, 23, 4.5) +
        CLOVE(8, 23, -50, 0.75) +
        `<g transform="translate(-4 4)">${CARDAMOM(10, 17, 60)}</g>`,
      '#A0663C',
    ),
    'mustard-seeds': grainHeap('#4A3A30', '#2A1C13', GRAIN.round('#3A2A22', '#1E1410'), 17),
    fennel: grainHeap('#A8C06A', '#6F8A36', GRAIN.oval('#9BB55A', '#617A2C'), 19),
    fenugreek: grainHeap('#E0B04E', '#A87A22', GRAIN.cube('#D9A441', '#9B6E1E'), 23),
    'bay-leaf': svg(
      '<path d="M5 27C8 15 16 6 27 4c-1 12-9 20-22 23z" fill="#8FA35A"/><path d="M5 27L25 6" stroke="#5E6E32" stroke-width="1" stroke-linecap="round"/><path d="M10 22l-3-3M14 18l-4-2M18 14l-3-3M14 18l3 3M10 22l3 2M18 14l4 1" stroke="#5E6E32" stroke-width=".6" stroke-linecap="round"/>' +
        '<path d="M10 29C15 21 21 17 29 16c-3 7-10 12-19 13z" fill="#7A8F47"/><path d="M10 29L27 17" stroke="#4E5D28" stroke-width=".8" stroke-linecap="round"/>',
    ),
    'star-anise': svg(STAR(16, 16, 12)),
    nutmeg: svg(
      '<ellipse cx="13" cy="17" rx="8" ry="9" fill="#8B5A2B"/><path d="M8 12c2 1 3 4 2 7M12 9c1 3 1 7-1 10M16 10c-1 3 0 6 2 9" stroke="#6B4220" stroke-width=".8" fill="none"/><ellipse cx="22" cy="20" rx="6.5" ry="7" fill="#A86F3A"/><path d="M18 18c1.6.6 2.4 2.4 2 4M22 15c.8 2 .8 4.6-.4 6.6M25 17c-1 1.6-1 3.6.4 5" stroke="#7E4E22" stroke-width=".7" fill="none"/><path d="M5 9c2-2 4-3 7-3" stroke="#D9261E" stroke-width="1.6" stroke-linecap="round"/>',
    ),
    saffron: svg(
      '<ellipse cx="16" cy="24" rx="12" ry="4" fill="#F4F4F4"/>' +
        scatter(18, 21, [6, 8, 26, 24])
          .map(
            (g) =>
              `<path d="M${f(g.x)} ${f(g.y)}l${f(Math.cos(g.r) * 5)} ${f(Math.sin(g.r) * 5)}" stroke="#E0451E" stroke-width="1.1" stroke-linecap="round"/><circle cx="${f(g.x + Math.cos(g.r) * 5)}" cy="${f(g.y + Math.sin(g.r) * 5)}" r=".8" fill="#FF822D"/>`,
          )
          .join(''),
    ),
    sesame: grainHeap('#F6EAD0', '#D2BC8C', GRAIN.split('#F3E3C1', '#C9AE7A'), 29),
    ajwain: grainHeap('#A89068', '#76603A', GRAIN.oval('#9C8458', '#6E5A36'), 31),
    asafoetida: svg(
      '<rect x="8" y="9" width="16" height="20" rx="2" fill="#FFB02E"/><rect x="8" y="5" width="16" height="5" rx="1" fill="#F8312F"/><rect x="10" y="14" width="12" height="10" rx="1" fill="#FFFFFF"/>' +
        LABEL_TEXT('HING', '#CA0B4A', 18) +
        '<circle cx="16" cy="22" r="1.4" fill="#E8C9A0"/>',
    ),
    tamarind: svg(
      [
        [16, 11, -15],
        [15, 21, 10],
      ]
        .map(
          ([x, y, r]) =>
            `<g transform="translate(${x} ${y}) rotate(${r})"><path d="M-12 1c1-2.6 2.6-3.4 4.4-3.4 1.6 0 2 1.4 3.6 1.4S-1.4-3.4.4-3.4 3.2-2 4.8-2 7.6-3.6 9.4-3.4c1.6.2 2.6 1.6 2.6 3.4 0 1.8-1.2 3.2-3 3.4-1.8.2-2.6-1-4.4-1S1.8 4 0 4-3 2.4-4.6 2.4-7.4 4-9 4c-1.8 0-3.6-1.2-3-3z" fill="#B07A42"/><path d="M-10 0c1-1 2-1.4 3-1.4M-2 -.4c1-.9 2-1.2 3-1.2M6 -1c1-.8 2-1 3-1" stroke="#D9A66B" stroke-width=".9" stroke-linecap="round"/><path d="M-12 1c3.4 1.2 20 1 24-1" stroke="#7E5228" stroke-width=".7" fill="none"/></g>`,
        )
        .join('') +
        '<path d="M22 27c2-.6 4.4.2 5 1.6" stroke="#6B4220" stroke-width="2.4" stroke-linecap="round"/><ellipse cx="7" cy="27.5" rx="4" ry="2" fill="#6B3A1E"/>',
    ),
    kokum: svg(
      [
        [10, 12, -20],
        [21, 11, 30],
        [11, 22, 50],
        [22, 22, -10],
      ]
        .map(
          ([x, y, r]) =>
            `<g transform="translate(${x} ${y}) rotate(${r})"><path d="M-6.5 1c0-4.4 3-7 6.5-7s6.5 2.6 6.5 7c-2.2 1.6-4.4 2.4-6.5 2.4S-4.3 2.6-6.5 1z" fill="#8C2E5E"/><path d="M-5 0c0-3 2.2-4.8 5-4.8S5-3 5 0c-1.6 1-3.3 1.5-5 1.5S-3.4 1-5 0z" fill="#B0477E"/><path d="M-3 -2.4c1-.9 2-1.3 3-1.3" stroke="#E07AB0" stroke-width=".8" stroke-linecap="round"/></g>`,
        )
        .join(''),
    ),

    // grains, flours, pulses
    rice: grainHeap('#FFFFFF', '#D9D2C2', GRAIN.rice('#FFFFFF', '#CFC6B0'), 37),
    'red-rice': grainHeap('#C2614A', '#8E3A26', GRAIN.rice('#B5503A', '#7E2E1F'), 37),
    'wheat-flour': sack(
      '#E6C48A',
      '#E8D3AE',
      at(10, 13, 0.4, WHEAT) + LABEL_TEXT('ATTA', '#7D4533', 24),
    ),
    maida: sack('#F4F4F4', '#FFFFFF', at(10, 13, 0.4, WHEAT) + LABEL_TEXT('MAIDA', '#00A6ED', 24)),
    besan: sack(
      '#FFE08A',
      '#F6D365',
      at(
        10,
        13,
        0.4,
        '<circle cx="12" cy="16" r="5" fill="#E8B04B"/><circle cx="20" cy="16" r="5" fill="#D99A2B"/>',
      ) + LABEL_TEXT('BESAN', '#B06A00', 24),
    ),
    'rice-flour': sack(
      '#FFFFFF',
      '#F4F4F4',
      at(10, 13, 0.4, '<ellipse cx="16" cy="16" rx="3" ry="8" fill="#E6E6E6" stroke="#B4B4B4"/>') +
        LABEL_TEXT('RICE', '#636363', 24),
    ),
    semolina: sack('#F3E3C1', '#EAD29A', LABEL_TEXT('RAVA', '#B06A00', 22), true),
    cornflour: sack(
      '#FFF3C4',
      '#FFFFFF',
      at(
        9,
        11,
        0.45,
        '<path d="M16 4c4 0 6 6 6 13s-2 11-6 11-6-4-6-11 2-13 6-13z" fill="#FFC83D"/><path d="M10 26c0-6 2-10 6-12M22 26c0-6-2-10-6-12" stroke="#00D26A" stroke-width="2"/>',
      ) + LABEL_TEXT('CORN', '#B06A00', 25),
    ),
    poha: grainHeap('#FAF3E4', '#D9C8A4', GRAIN.flake('#F7EEDC', '#CDBB98'), 41),
    oats: grainHeap('#E8D3AE', '#B8996A', GRAIN.flake('#E3CBA0', '#B08F5A'), 43),
    'toor-dal': grainHeap('#FFCF4A', '#E0A100', GRAIN.split('#FFC83D', '#D99A2B'), 47),
    'moong-dal': grainHeap('#6FAE2A', '#3F7A12', GRAIN.bean('#5E9E1F', '#3F7A12'), 53),
    'masoor-dal': grainHeap('#FF8F3D', '#D96B1F', GRAIN.split('#FF822D', '#D96B1F'), 59),
    'urad-dal': grainHeap('#3A3A3A', '#1A1A1A', GRAIN.bean('#2A2A2A', '#000000', '#F4F4F4'), 61),
    chana: svg(
      scatter(16, 67, [6, 7, 26, 26])
        .map(
          (g) =>
            `<circle cx="${f(g.x)}" cy="${f(g.y)}" r="2.8" fill="#E8C07A" stroke="#B08F5A" stroke-width=".5"/><path d="M${f(g.x - 1.6)} ${f(g.y - 1.2)}q1.6 1 1.4 2.8" stroke="#B08F5A" stroke-width=".5" fill="none"/>`,
        )
        .join(''),
    ),
    pasta: svg(
      [
        [9, 12, 30],
        [19, 10, -20],
        [13, 21, 70],
        [22, 21, 10],
      ]
        .map(
          ([x, y, r]) =>
            `<g transform="translate(${x} ${y}) rotate(${r})"><path d="M-6 -2.5h10l2 5H-4z" fill="#FFC83D"/><path d="M-4 -2.5l2 5M-1 -2.5l2 5M2 -2.5l2 5" stroke="#E0A100" stroke-width=".6"/></g>`,
        )
        .join(''),
    ),
    pao: svg(
      '<rect x="3" y="12" width="26" height="15" rx="4" fill="#D98B3E"/>' +
        [0, 1, 2]
          .map(
            (i) =>
              `<path d="M${3 + i * 8.7} 20c0-6 2-9 4.35-9s4.35 3 4.35 9z" fill="#E8A256"/><path d="M${4.5 + i * 8.7} 15c1-2 2-3 3-3" stroke="#F6C98A" stroke-width="1.2" stroke-linecap="round"/>`,
          )
          .join('') +
        '<path d="M11.7 13v14M20.4 13v14" stroke="#B5682A" stroke-width=".9"/>' +
        scatter(10, 71, [5, 13, 27, 18])
          .map((g) => `<circle cx="${f(g.x)}" cy="${f(g.y)}" r=".45" fill="#FFFFFF"/>`)
          .join(''),
    ),

    // dairy
    curd: bowl(
      '#FFFFFF',
      '#B4ACBC',
      '<path d="M10 13c2 1.5 4 1.5 6 0s4-1.5 6 0" stroke="#E6E6E6" stroke-width="1.2" fill="none"/>',
    ),
    paneer: svg(
      [
        [6, 16],
        [16, 14],
        [11, 23],
        [21, 22],
      ]
        .map(
          ([x, y]) =>
            `<path d="M${x} ${y}l4-3h6l-4 3z" fill="#FFFFFF"/><path d="M${x} ${y}h6v6h-6z" fill="#FFF7E6" stroke="#E6D8BC" stroke-width=".5"/><path d="M${x! + 6} ${y}l4-3v6l-4 3z" fill="#EFE3C8"/>`,
        )
        .join(''),
    ),
    ghee: jar(
      '#FFC83D',
      '#00A35C',
      '<path d="M8.5 15c3-1.5 5-1.5 7.5 0s5 1.5 7.5 0" stroke="#FFDA6B" stroke-width="1.4" fill="none"/>',
      LABEL_TEXT('GHEE', '#B06A00', 21),
    ),
    cream: carton(
      '#FFFFFF',
      '#00A6ED',
      at(
        10.5,
        14.5,
        0.35,
        '<path d="M8 22c0-8 4-14 8-14s8 6 8 14z" fill="#F4F4F4" stroke="#B4B4B4" stroke-width="1.2"/><path d="M16 8c-1-2 0-4 2-5" stroke="#B4B4B4" stroke-width="1.2"/>',
      ) + LABEL_TEXT('CREAM', '#00A6ED', 23),
    ),
    'condensed-milk': svg(
      '<rect x="7" y="9" width="18" height="18" rx="2" fill="#E6E6E6"/><ellipse cx="16" cy="9" rx="9" ry="2.6" fill="#D3D3D3"/><rect x="7" y="13" width="18" height="10" fill="#00A6ED"/><path d="M12 15c0 4 2 6 4 6s4-2 4-6" fill="#FFFFFF"/>' +
        LABEL_TEXT('MILK', '#FFFFFF', 13.4),
    ),

    // meat and fish
    sausage: svg(
      '<path d="M8 17c1.6-1.4 2.4-1.4 3.6 0M18.6 17c1.6-1.4 2.4-1.4 3.6 0" stroke="#7E1E18" stroke-width="1.4" stroke-linecap="round"/>' +
        [5, 15.3, 25.6]
          .map(
            (x) =>
              `<ellipse cx="${x + 0.5}" cy="17" rx="5" ry="6.4" fill="#B5302A"/><ellipse cx="${x + 0.5}" cy="17" rx="5" ry="6.4" fill="none" stroke="#7E1E18" stroke-width=".7"/><path d="M${x - 2} 14c.8-1.4 2-2 3.4-2" stroke="#E8746C" stroke-width="1.1" stroke-linecap="round"/><circle cx="${x + 1.6}" cy="18.6" r=".6" fill="#F4C9A0"/><circle cx="${x - 1}" cy="20" r=".5" fill="#F4C9A0"/>`,
          )
          .join(''),
    ),
    'dried-fish': svg(
      '<path d="M3 16c5-6 15-7 22-3l4-4v14l-4-4c-7 4-17 3-22-3z" fill="#C9A66B"/><path d="M8 14v4M12 13v6M16 13v6M20 13.5v5" stroke="#8C6B42" stroke-width=".8"/><circle cx="7" cy="15" r="1" fill="#3F2A20"/>' +
        '<path d="M6 26c4-3 10-4 15-2l3-2v8l-3-2c-5 2-11 1-15-2z" fill="#B08F5A"/>',
    ),

    // pantry
    oil: bottle({
      glass: '#FFE58A',
      liquid: '#FFC83D',
      cap: '#FF822D',
      shape: 'tall',
      sign: at(
        11,
        11,
        0.32,
        '<circle cx="16" cy="16" r="5" fill="#7D4533"/>' +
          [0, 45, 90, 135, 180, 225, 270, 315]
            .map(
              (a) =>
                `<ellipse cx="16" cy="6" rx="2.4" ry="5" fill="#FFB02E" transform="rotate(${a} 16 16)"/>`,
            )
            .join('') +
          '<circle cx="16" cy="16" r="4.5" fill="#7D4533"/>',
      ),
    }),
    'coconut-oil': bottle({
      glass: '#F6F2E6',
      liquid: '#FFFFFF',
      cap: '#00A35C',
      shape: 'tall',
      sign: at(11, 11, 0.32, COCONUT),
    }),
    'olive-oil': bottle({
      glass: '#7A8F2A',
      liquid: '#9DB33A',
      cap: '#3F2A20',
      shape: 'tall',
      sign: at(
        11,
        11,
        0.32,
        '<ellipse cx="13" cy="17" rx="4" ry="5" fill="#44911B"/><ellipse cx="20" cy="15" rx="4" ry="5" fill="#2E6B0F"/><path d="M10 9c3 0 7 1 12-2" stroke="#7D4533" stroke-width="1.6"/>',
      ),
    }),
    'mustard-oil': bottle({
      glass: '#F6D365',
      liquid: '#E0A100',
      cap: '#F8312F',
      shape: 'tall',
      sign: at(
        11,
        11,
        0.32,
        '<circle cx="12" cy="16" r="3.5" fill="#FFC83D"/><circle cx="20" cy="16" r="3.5" fill="#FFC83D"/><circle cx="16" cy="11" r="3.5" fill="#FFC83D"/><circle cx="16" cy="21" r="3.5" fill="#FFC83D"/>',
      ),
    }),
    sugar: heap(
      '#FFFFFF',
      '#D9D9D9',
      at(
        19,
        15,
        0.38,
        '<rect x="6" y="10" width="10" height="10" fill="#FFFFFF" stroke="#C4C4C4" stroke-width="1.4"/><rect x="16" y="14" width="10" height="10" fill="#FFFFFF" stroke="#C4C4C4" stroke-width="1.4"/>',
      ),
      '#E6E6E6',
    ),
    jaggery: svg(
      '<path d="M6 15l6-6h14l-6 6z" fill="#D58A3C"/><path d="M6 15h14v12H6z" fill="#A65E1F"/><path d="M20 15l6-6v12l-6 6z" fill="#8A4A14"/>' +
        scatter(10, 73, [8, 17, 18, 25])
          .map((g) => `<circle cx="${f(g.x)}" cy="${f(g.y)}" r=".6" fill="#C47830"/>`)
          .join('') +
        '<path d="M9 30l3-3h7l-3 3z" fill="#B86E2C"/>',
    ),
    vinegar: bottle({
      glass: '#E6F4FF',
      liquid: '#F6E9C8',
      cap: '#636363',
      shape: 'tall',
      sign: LABEL_TEXT('VINEGAR', '#7D4533', 16).replace('font-size="4.6"', 'font-size="2.6"'),
    }),
    ketchup: bottle({
      glass: '#D9261E',
      cap: '#F4F4F4',
      shape: 'sauce',
      label: '#FFFFFF',
      sign: at(
        11,
        11,
        0.32,
        '<circle cx="16" cy="17" r="9" fill="#F8312F"/><path d="M13 8l3 3 3-3" stroke="#00A35C" stroke-width="2" fill="none"/>',
      ),
    }),
    'soy-sauce': bottle({
      glass: '#3F2A20',
      cap: '#F8312F',
      shape: 'sauce',
      label: '#FFFFFF',
      sign: LABEL_TEXT('SOY', '#3F2A20', 16),
    }),
    'chilli-sauce': bottle({
      glass: '#F8312F',
      cap: '#00A35C',
      shape: 'sauce',
      label: '#FFFFFF',
      sign: at(11, 11, 0.32, CHILLI),
    }),
    mayonnaise: jar('#FFF6D6', '#00A6ED', '', LABEL_TEXT('MAYO', '#00A6ED', 20)),
    'coconut-milk': carton(
      '#FFFFFF',
      '#7D4533',
      at(10.5, 14.5, 0.35, COCONUT) +
        '<path d="M18 23c1.5 1.4 3 1.4 4 0" stroke="#B4B4B4" stroke-width=".8"/>',
    ),
    cashew: svg(
      scatter(9, 79, [7, 8, 25, 25])
        .map(
          (g) =>
            `<g transform="translate(${f(g.x)} ${f(g.y)}) rotate(${f(g.r)})"><path d="M-3.6 -1.4c0-2.6 2.4-4 4.6-3.4 1.6.4 2.4 2 1.6 3.2-.6 1-1.8 1-2.4 2 -.6 1 .2 2.4 1.6 2.8C1 4.6-3.6 3.6-3.6 -1.4z" fill="#F6D9A6" stroke="#D2A86A" stroke-width=".5"/></g>`,
        )
        .join(''),
    ),
    almond: svg(
      scatter(9, 83, [7, 8, 25, 25])
        .map(
          (g) =>
            `<g transform="translate(${f(g.x)} ${f(g.y)}) rotate(${f(g.r)})"><path d="M0 -4.4c2.4 1.4 3 4 2.4 6S.6 4.6 0 4.6-1.8 3.6-2.4 1.6-2.4 -3 0 -4.4z" fill="#A86A3D" stroke="#7A4A26" stroke-width=".5"/><path d="M-.6 -2.4c-.4 1.6-.4 3.6.2 5" stroke="#7A4A26" stroke-width=".4"/></g>`,
        )
        .join(''),
    ),
    raisins: grainHeap('#7A4466', '#4A2340', GRAIN.bean('#6B3A5A', '#4A2340'), 89),
    dates: svg(
      [
        [10, 12, -20],
        [20, 11, 25],
        [14, 21, 80],
        [23, 21, 10],
      ]
        .map(
          ([x, y, r]) =>
            `<g transform="rotate(${r} ${x} ${y})"><ellipse cx="${x}" cy="${y}" rx="3.4" ry="5.8" fill="#6B2E14"/><path d="M${x! - 1.4} ${y! - 3}q1 3 0 6M${x! + 1} ${y! - 4}q-.8 4 .2 7" stroke="#8B4520" stroke-width=".7" fill="none"/></g>`,
        )
        .join(''),
    ),
    chips: svg(
      '<path d="M7 5h18l-1.5 3 1.5 3v14l1.5 3H5.5L7 25V11L5.5 8z" fill="#FFB02E"/><path d="M7 5h18l-1.5 3H8.5z" fill="#F8312F"/><path d="M5.5 28h21L25 25H7z" fill="#F8312F"/><ellipse cx="16" cy="17.5" rx="6" ry="4.5" fill="#FFE08A"/><ellipse cx="16" cy="17.5" rx="6" ry="4.5" fill="none" stroke="#D99A2B" stroke-width=".8"/>' +
        '<circle cx="14" cy="16.5" r=".6" fill="#D99A2B"/><circle cx="17.5" cy="18.5" r=".6" fill="#D99A2B"/>',
    ),
    nachos: svg(
      [
        [9, 11, 0],
        [18, 9, 30],
        [12, 20, -20],
        [22, 19, 15],
        [16, 25, 60],
      ]
        .map(
          ([x, y, r]) =>
            `<g transform="rotate(${r} ${x} ${y})"><path d="M${x} ${y! - 5}l5 8.5h-10z" fill="#FFC83D" stroke="#E0A100" stroke-width=".6"/><circle cx="${x! - 1}" cy="${y! + 1}" r=".5" fill="#E0A100"/><circle cx="${x! + 1.4}" cy="${y! + 2}" r=".5" fill="#E0A100"/></g>`,
        )
        .join(''),
    ),
    frozen: svg(
      '<rect x="5" y="6" width="22" height="22" rx="3" fill="#BEE9FF"/><rect x="5" y="6" width="22" height="22" rx="3" fill="none" stroke="#00A6ED" stroke-width="1.2"/>' +
        at(7, 8, 0.56, SNOW),
    ),

    // prep from the kitchen and bar
    'masala-paste': bowl(
      '#B5302A',
      '#7D4533',
      '<path d="M9 13.5c2-1 4 0 6-1s4-1 6 0 2 1 2 1" stroke="#D9625A" stroke-width="1" fill="none"/>' +
        at(17, 2, 0.32, CHILLI) +
        at(
          5,
          3,
          0.3,
          '<path d="M16 6c5 0 8 4 8 9s-3 9-8 9-8-4-8-9 3-9 8-9z" fill="#FFF3D6"/><path d="M16 7v16M12 9c-1 4-1 9 0 13M20 9c1 4 1 9 0 13" stroke="#E6D3A6" stroke-width="1.2"/>',
        ),
    ),
    chutney: bowl(
      '#44911B',
      '#E6E6E6',
      '<path d="M9 13.5c2-1 4 0 6-1s4-1 6 0" stroke="#86D72F" stroke-width="1" fill="none"/>' +
        at(18, 2, 0.3, LEAF),
    ),
    dough: svg(
      '<ellipse cx="16" cy="25" rx="13" ry="4" fill="#B4ACBC"/><path d="M5 22c0-6 5-11 11-11s11 5 11 11c-3 2-7 3-11 3S8 24 5 22z" fill="#F6E3C1"/><path d="M10 16c2-2 4-3 7-3" stroke="#FFFFFF" stroke-width="1.4" stroke-linecap="round"/>' +
        scatter(6, 97, [8, 18, 24, 23])
          .map((g) => `<circle cx="${f(g.x)}" cy="${f(g.y)}" r=".5" fill="#E2C89A"/>`)
          .join(''),
    ),
    syrup: bottle({
      glass: '#E6F4FF',
      liquid: '#FFDA9A',
      cap: '#CA0B4A',
      shape: 'round',
      sign: at(
        11,
        11,
        0.32,
        '<path d="M16 4c4 6 8 10.5 8 15a8 8 0 0 1-16 0c0-4.5 4-9 8-15z" fill="#FFB02E"/>',
      ),
    }),
    tepache: svg(
      '<rect x="6" y="8" width="20" height="21" rx="4" fill="#D9F0FF" fill-opacity=".75"/><rect x="7" y="13" width="18" height="15" rx="3" fill="#FFC83D"/><rect x="5.5" y="4" width="21" height="5" rx="1.2" fill="#7D4533"/>' +
        at(
          8,
          12,
          0.5,
          '<path d="M16 12c5 0 8 4 8 9s-3 9-8 9-8-4-8-9 3-9 8-9z" fill="#FFB02E"/><path d="M11 15l10 10M21 15L11 25M16 12v18" stroke="#E08A00" stroke-width="1"/><path d="M16 12c-2-4-1-8 0-10 1 2 2 6 0 10M16 12c2-3 5-5 7-4-1 2-4 4-7 4M16 12c-2-3-5-5-7-4 1 2 4 4 7 4" fill="#00D26A"/>',
        ) +
        '<circle cx="11" cy="16" r=".9" fill="#FFFFFF" fill-opacity=".8"/><circle cx="21" cy="18" r=".7" fill="#FFFFFF" fill-opacity=".8"/>',
    ),
    'batched-cocktail': svg(
      '<path d="M8 6h14l-1 3c3 2 5 6 5 11v6c0 1.7-1.3 3-3 3H8c-1.7 0-3-1.3-3-3v-6c0-5 2-9 4-11z" fill="#D9F0FF" fill-opacity=".8"/><path d="M5.2 16h20.6c.1 1.3.2 2.6.2 4v6c0 1.7-1.3 3-3 3H8c-1.7 0-3-1.3-3-3v-6c0-1.4.1-2.7.2-4z" fill="#CA0B4A"/>' +
        '<circle cx="11" cy="21" r="2.4" fill="#FF822D"/><circle cx="18" cy="23" r="2.2" fill="#FFB02E"/><path d="M22 9c3 0 5 2 5 5s-2 5-5 5" stroke="#B4ACBC" stroke-width="2" fill="none"/><rect x="7" y="3.5" width="16" height="3" rx="1" fill="#636363"/>',
    ),

    // drinks
    water: bottle({
      glass: '#BEE9FF',
      liquid: '#9AD9FF',
      cap: '#00A6ED',
      shape: 'round',
      label: '#00A6ED',
      sign: at(
        11,
        11,
        0.32,
        '<path d="M16 5c4 6 8 10.5 8 15a8 8 0 0 1-16 0c0-4.5 4-9 8-15z" fill="#FFFFFF"/>',
      ),
    }),
    soda: bottle({
      glass: '#BEE9FF',
      liquid: '#E6F7FF',
      cap: '#00A35C',
      shape: 'beer',
      label: '#00A35C',
      sign: scatter(6, 101, [12, 14, 20, 18])
        .map(
          (g) =>
            `<circle cx="${f(g.x)}" cy="${f(g.y)}" r=".9" fill="none" stroke="#FFFFFF" stroke-width=".6"/>`,
        )
        .join(''),
    }),
    tonic: can(
      '#F4F4F4',
      '#FFC83D',
      at(
        10,
        13.4,
        0.36,
        '<path d="M8 6h16l-2 8H10z" fill="#00A6ED"/><path d="M16 14v10M10 24h12" stroke="#00A6ED" stroke-width="2"/>',
      ) + LABEL_TEXT('TONIC', '#7D4533', 21.4).replace('font-size="4.6"', 'font-size="3.4"'),
    ),
    cola: can(
      '#D9261E',
      '#FFFFFF',
      '<path d="M10 17.5c3-2 8-2 12 0" stroke="#D9261E" stroke-width="1.6" fill="none"/>' +
        LABEL_TEXT('COLA', '#D9261E', 14.6).replace('font-size="4.6"', 'font-size="3.4"'),
    ),
    'orange-juice': carton('#FFB02E', '#FF822D', at(10.5, 14.5, 0.36, ORANGE_SLICE)),
    'cranberry-juice': carton('#CA0B4A', '#8C0A36', at(10.5, 14.5, 0.36, BERRIES)),
    coffee: svg(
      [
        [10, 11, -30],
        [20, 9, 25],
        [15, 18, 70],
        [24, 19, -10],
        [9, 23, 40],
        [19, 26, -60],
      ]
        .map(([x, y, r]) => COFFEE_BEAN(x!, y!, r!))
        .join(''),
    ),
    beer: bottle({
      glass: '#8A4B14',
      liquid: '#8A4B14',
      cap: '#FFC83D',
      shape: 'beer',
      label: '#FFC83D',
      sign: at(11.6, 13, 0.27, WHEAT),
    }),
    'red-wine': bottle({
      glass: '#5E1A2E',
      liquid: '#5E1A2E',
      cap: '#8C0A36',
      shape: 'wine',
      label: '#F6EEDC',
      sign: at(
        11.5,
        12,
        0.28,
        '<g fill="#7A1F4C">' +
          [
            [12, 10],
            [20, 10],
            [16, 14],
            [12, 18],
            [20, 18],
            [16, 22],
          ]
            .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3.6"/>`)
            .join('') +
          '</g>',
      ),
    }),
    'white-wine': bottle({
      glass: '#C9D88A',
      liquid: '#E6E9A8',
      cap: '#D3B35A',
      shape: 'wine',
      label: '#FFFFFF',
      sign: at(
        11.5,
        12,
        0.28,
        '<g fill="#A6C94A">' +
          [
            [12, 10],
            [20, 10],
            [16, 14],
            [12, 18],
            [20, 18],
            [16, 22],
          ]
            .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3.6"/>`)
            .join('') +
          '</g>',
      ),
    }),
    vodka: bottle({
      glass: '#E6F4FF',
      cap: '#B4B4B4',
      shape: 'tall',
      label: '#FFFFFF',
      sign: at(11.5, 11, 0.28, SNOW),
    }),
    gin: bottle({
      glass: '#D9F0FF',
      cap: '#3D4FB0',
      shape: 'square',
      label: '#E8ECFF',
      sign: at(10.5, 10, 0.34, JUNIPER),
    }),
    whisky: bottle({
      glass: '#D9F0FF',
      liquid: '#C47A1A',
      cap: '#3F2A20',
      shape: 'square',
      label: '#FFF3D6',
      sign: LABEL_TEXT('W', '#7D4533', 16),
    }),
    'single-malt': bottle({
      glass: '#D9F0FF',
      liquid: '#A85C12',
      cap: '#1F2A44',
      shape: 'round',
      label: '#1F2A44',
      sign: at(10.5, 10.5, 0.34, WHEAT),
    }),
    bourbon: bottle({
      glass: '#D9F0FF',
      liquid: '#B5651D',
      cap: '#B5302A',
      shape: 'squat',
      label: '#F6EEDC',
      sign: LABEL_TEXT('B', '#B5302A', 16),
    }),
    'dark-rum': bottle({
      glass: '#3F2A20',
      liquid: '#5A3418',
      cap: '#C9A227',
      shape: 'squat',
      label: '#C9A227',
      sign: at(10, 10, 0.38, PALM),
    }),
    'white-rum': bottle({
      glass: '#E6F4FF',
      cap: '#C9A227',
      shape: 'spirit',
      label: '#FFFFFF',
      sign: at(10.5, 10.5, 0.34, PALM),
    }),
    tequila: bottle({
      glass: '#E6F4FF',
      liquid: '#F6F2DC',
      cap: '#7D4533',
      shape: 'squat',
      label: '#FFFFFF',
      sign: at(10, 10.5, 0.36, AGAVE),
    }),
    brandy: bottle({
      glass: '#D9F0FF',
      liquid: '#9B4A12',
      cap: '#C9A227',
      shape: 'round',
      label: '#F6EEDC',
      sign: LABEL_TEXT('XO', '#9B4A12', 16),
    }),
    feni: bottle({
      glass: '#E6F4FF',
      liquid: '#F6F2DC',
      cap: '#FF822D',
      shape: 'round',
      label: '#FFFFFF',
      sign: at(10.5, 10.5, 0.34, CASHEW_APPLE),
    }),
    'feni-nip': bottle({
      glass: '#E6F4FF',
      liquid: '#F6F2DC',
      cap: '#FF822D',
      shape: 'small',
      label: '#FFFFFF',
      sign: at(11.5, 12, 0.28, CASHEW_APPLE),
    }),
    liqueur: bottle({
      glass: '#8D65C5',
      cap: '#C9A227',
      shape: 'round',
      label: '#FFFFFF',
      sign: LABEL_TEXT('L', '#8D65C5', 16),
    }),
    'coffee-liqueur': bottle({
      glass: '#2A1C13',
      cap: '#F8312F',
      shape: 'round',
      label: '#FFC83D',
      sign: COFFEE_BEAN(16, 16, 20).replace('#6D4534', '#3F2A20'),
    }),
    'triple-sec': bottle({
      glass: '#FFB02E',
      liquid: '#FFDA6B',
      cap: '#FF822D',
      shape: 'square',
      label: '#FFFFFF',
      sign: at(10.5, 10, 0.34, ORANGE_SLICE),
    }),
    vermouth: bottle({
      glass: '#7A1F2E',
      cap: '#C9A227',
      shape: 'wine',
      label: '#F6EEDC',
      sign: LABEL_TEXT('V', '#7A1F2E', 16),
    }),
    aperitif: bottle({
      glass: '#E0115F',
      liquid: '#D9261E',
      cap: '#3F2A20',
      shape: 'spirit',
      label: '#FFFFFF',
      sign: at(
        10.5,
        10.5,
        0.34,
        ORANGE_SLICE.replace(/#FF822D/g, '#F8312F').replace(/#FFB02E/g, '#FF6B6B'),
      ),
    }),
    bitters: bottle({
      glass: '#7D4533',
      cap: '#FFC83D',
      shape: 'small',
      label: '#FFF3D6',
      sign: LABEL_TEXT('BITTERS', '#7D4533', 16).replace('font-size="4.6"', 'font-size="2.2"'),
    }),
    'cocktail-napkins': svg(
      '<path d="M5 12l11-5 11 5-11 5z" fill="#FFFFFF" stroke="#D3D3D3" stroke-width=".6"/><path d="M5 12v3l11 5 11-5v-3l-11 5z" fill="#E6E6E6"/><path d="M5 15v3l11 5 11-5v-3l-11 5z" fill="#F4F4F4"/><path d="M5 18v3l11 5 11-5v-3l-11 5z" fill="#E6E6E6"/>' +
        at(
          10.5,
          5.5,
          0.34,
          '<path d="M8 6h16l-8 10z" fill="#F92F60"/><path d="M16 16v10M11 26h10" stroke="#F92F60" stroke-width="2"/>',
        ),
    ),

    // rooms
    'bath-towel': cloth('#FFFFFF', '#B4ACBC', '#00A6ED'),
    'hand-towel': svg(
      '<rect x="8" y="17" width="16" height="10" rx="2.5" fill="#FFFFFF" stroke="#B4ACBC" stroke-width=".8"/><path d="M10 22h12" stroke="#B4ACBC" stroke-width=".7" stroke-dasharray="1.2 1"/><rect x="8" y="9" width="16" height="9" rx="2.5" fill="#FFFFFF" stroke="#B4ACBC" stroke-width=".8"/><path d="M10 13.5h12" stroke="#B4ACBC" stroke-width=".7" stroke-dasharray="1.2 1"/><rect x="19" y="9" width="2" height="18" fill="#00A6ED"/>',
    ),
    'pool-towel': svg(
      '<rect x="4" y="12" width="24" height="15" rx="3" fill="#00A6ED"/>' +
        [0, 1, 2, 3]
          .map((i) => `<rect x="${7 + i * 5.5}" y="12" width="2.6" height="15" fill="#FFFFFF"/>`)
          .join('') +
        '<path d="M4 17c8 1.5 16 1.5 24 0" stroke="#0074BA" stroke-width=".8" fill="none"/><path d="M8 9c2-2 4-2 6 0s4 2 6 0 4-2 6 0" stroke="#00A6ED" stroke-width="1.4" fill="none" stroke-linecap="round"/>',
    ),
    bedsheet: svg(
      '<rect x="4" y="20" width="24" height="7" rx="1.5" fill="#E8ECFF" stroke="#8C9BD9" stroke-width=".7"/><rect x="4" y="13" width="24" height="7" rx="1.5" fill="#FFFFFF" stroke="#8C9BD9" stroke-width=".7"/><rect x="4" y="6" width="24" height="7" rx="1.5" fill="#E8ECFF" stroke="#8C9BD9" stroke-width=".7"/><path d="M4 9.5h24M4 16.5h24M4 23.5h24" stroke="#C3CCF5" stroke-width=".6"/><path d="M24 6v21" stroke="#8C9BD9" stroke-width=".6"/>',
    ),
    pillow: svg(
      '<path d="M5 11c0-2 1-3 3-3h16c2 0 3 1 3 3-1 2-1 8 0 10 0 2-1 3-3 3H8c-2 0-3-1-3-3 1-2 1-8 0-10z" fill="#FFFFFF" stroke="#B4ACBC" stroke-width=".9"/><path d="M5.5 9.5l-2-2M26.5 9.5l2-2M5.5 22.5l-2 2M26.5 22.5l2 2" stroke="#B4ACBC" stroke-width="1.2" stroke-linecap="round"/><path d="M9 12c4 2 10 2 14 0" stroke="#E6E6E6" stroke-width="1" fill="none"/>',
    ),
    blanket: cloth('#8D65C5', '#5B3E8A', undefined, 3),
    bathrobe: svg(
      '<path d="M10 5l6 6 6-6 6 4-3 5-2-1v15H9V13l-2 1-3-5z" fill="#FFFFFF" stroke="#B4ACBC" stroke-width=".9"/><path d="M10 5l6 9 6-9M16 14v14" stroke="#B4ACBC" stroke-width=".9"/><path d="M9 19h14" stroke="#00A6ED" stroke-width="1.6"/>',
    ),
    slippers: svg(
      '<path d="M5 9c0-3 2-5 4-5s4 2 4 5v15c0 2.5-1.8 4-4 4s-4-1.5-4-4z" fill="#FFFFFF" stroke="#B4ACBC" stroke-width=".8"/><path d="M5 12c2-2 6-2 8 0v4H5z" fill="#00A6ED"/><path d="M19 9c0-3 2-5 4-5s4 2 4 5v15c0 2.5-1.8 4-4 4s-4-1.5-4-4z" fill="#FFFFFF" stroke="#B4ACBC" stroke-width=".8"/><path d="M19 12c2-2 6-2 8 0v4h-8z" fill="#00A6ED"/>',
    ),
    tissues: svg(
      '<path d="M5 14h22v13H5z" fill="#00A6ED"/><path d="M5 14l4-4h14l4 4z" fill="#38BDF8"/><ellipse cx="16" cy="12" rx="5" ry="1.6" fill="#0074BA"/><path d="M12 12c0-4 2-7 4-8 2 1 4 4 4 8" fill="#FFFFFF" stroke="#D3D3D3" stroke-width=".6"/><path d="M8 19h16" stroke="#FFFFFF" stroke-opacity=".6" stroke-width="1"/>',
    ),
    'sanitary-bag': svg(
      '<path d="M8 9h16l2 19H6z" fill="#F4F4F4" stroke="#B4ACBC" stroke-width=".8"/><path d="M12 9c0-3 1.8-5 4-5s4 2 4 5" stroke="#B4ACBC" stroke-width="1.4" fill="none"/><rect x="11" y="15" width="10" height="8" rx="1" fill="#F92F60" fill-opacity=".85"/><path d="M13.5 19h5M16 16.5v5" stroke="#FFFFFF" stroke-width="1.2"/>',
    ),
    'pool-chlorine': svg(
      '<path d="M7 11h18l-1.5 16.5c-.1 1.4-1.2 2.5-2.6 2.5H11.1c-1.4 0-2.5-1.1-2.6-2.5z" fill="#00A6ED"/><rect x="6" y="7" width="20" height="5" rx="1.2" fill="#0074BA"/><rect x="10" y="15" width="12" height="9" rx="1" fill="#FFFFFF"/>' +
        LABEL_TEXT('Cl', '#0074BA', 18.4) +
        '<path d="M11 31c2-1 3-1 5 0s3 1 5 0" stroke="#00A6ED" stroke-width="1" fill="none"/>',
    ),

    // cleaning
    'floor-cleaner': jug(
      '#86D72F',
      '#00A35C',
      at(
        11,
        16,
        0.3,
        '<path d="M14 4v16" stroke="#7D4533" stroke-width="2.4"/><path d="M8 20h12l2 8H6z" fill="#00A6ED"/>',
      ),
    ),
    'glass-cleaner': spray(
      '#E6F4FF',
      '#00A6ED',
      at(
        11.5,
        19.5,
        0.28,
        '<rect x="6" y="6" width="20" height="20" fill="#FFFFFF" stroke="#00A6ED" stroke-width="2"/><path d="M16 6v20M6 16h20" stroke="#00A6ED" stroke-width="2"/>',
      ),
    ),
    'toilet-cleaner': svg(
      '<path d="M10 14c0-2 1.6-3.6 3.6-3.6h4.8c2 0 3.6 1.6 3.6 3.6v13.5c0 1.4-1.1 2.5-2.5 2.5h-7c-1.4 0-2.5-1.1-2.5-2.5z" fill="#00A6ED"/><path d="M13 10.4V6.5l6-3 1.5 2-4 2.5v2.4" fill="#0074BA"/><rect x="12" y="16" width="8" height="9" rx="1" fill="#FFFFFF"/>' +
        at(
          12,
          16.5,
          0.25,
          '<path d="M8 10h16v6c0 5-4 8-8 8s-8-3-8-8z" fill="#00A6ED"/><rect x="11" y="24" width="10" height="4" fill="#00A6ED"/>',
        ),
    ),
    'dish-wash': jug(
      '#86D72F',
      '#F8312F',
      at(
        11,
        16,
        0.3,
        '<ellipse cx="16" cy="18" rx="11" ry="5" fill="#B4ACBC"/><ellipse cx="16" cy="17" rx="8" ry="3.4" fill="#F4F4F4"/>' +
          [
            [10, 8],
            [17, 6],
            [22, 10],
          ]
            .map(
              ([x, y]) =>
                `<circle cx="${x}" cy="${y}" r="3" fill="none" stroke="#00A6ED" stroke-width="1.4"/>`,
            )
            .join(''),
      ),
    ),
    detergent: svg(
      '<path d="M6 9h20v19c0 1.1-.9 2-2 2H8c-1.1 0-2-.9-2-2z" fill="#00A6ED"/><path d="M6 9l3-4h14l3 4z" fill="#0074BA"/><circle cx="16" cy="19" r="6.5" fill="#FFFFFF"/><circle cx="16" cy="19" r="4.5" fill="#F92F60"/><path d="M13 17c1.4-1.4 4.6-1.4 6 0" stroke="#FFFFFF" stroke-width="1.2" fill="none"/>',
    ),
    'hand-wash': svg(
      '<path d="M10 14c0-2 1.6-3.6 3.6-3.6h4.8c2 0 3.6 1.6 3.6 3.6v13.5c0 1.4-1.1 2.5-2.5 2.5h-7c-1.4 0-2.5-1.1-2.5-2.5z" fill="#F92F60"/><rect x="14.5" y="6" width="3" height="4.6" fill="#B4ACBC"/><path d="M12 4h8.5l2 2.6" stroke="#B4ACBC" stroke-width="2.2" fill="none" stroke-linecap="round"/><rect x="12" y="16" width="8" height="9" rx="1" fill="#FFFFFF"/>' +
        at(
          12,
          16.4,
          0.25,
          '<path d="M10 26V14c0-1.4 2-1.4 2 0v6V9c0-1.4 2-1.4 2 0v11V8c0-1.4 2-1.4 2 0v12V9c0-1.4 2-1.4 2 0v13l2-3c1-1.4 3-.4 2 1.2L18 28h-6c-1.4 0-2-1-2-2z" fill="#FFB02E"/>',
        ),
    ),
    'garbage-bags': svg(
      '<path d="M8 14c0-5 3-8 8-8s8 3 8 8v10c0 3-3 5-8 5s-8-2-8-5z" fill="#2A2A2A"/><path d="M12 6c-1-2 0-4 2-3s1 3 2 3 1-2 2-3 3 1 2 3" fill="#2A2A2A"/><path d="M11 12c1 4 1 9 0 13M16 10v16" stroke="#4A4A4A" stroke-width="1"/><path d="M19 12c1.4-1 2.4-.8 3 .4" stroke="#6E6E6E" stroke-width="1" stroke-linecap="round"/>' +
        '<rect x="20" y="20" width="10" height="9" rx="3" fill="#4A4A4A"/><ellipse cx="29" cy="24.5" rx="1.4" ry="4.4" fill="#2A2A2A"/>',
    ),

    // packaging
    foil: roll('#C9CCD1', '#E6E8EB', '#DDE1E6'),
    'cling-film': roll('#E6F4FF', '#FFFFFF', '#F2FAFF'),
    'butter-paper': roll('#F6EEDC', '#FFFFFF', '#FBF5E8'),
    'paper-napkins': svg(
      '<path d="M5 11h22v4H5z" fill="#FFFFFF" stroke="#D3D3D3" stroke-width=".6"/><path d="M5 15h22v4H5z" fill="#F4F4F4" stroke="#D3D3D3" stroke-width=".6"/><path d="M5 19h22v4H5z" fill="#FFFFFF" stroke="#D3D3D3" stroke-width=".6"/><path d="M5 23h22v4H5z" fill="#F4F4F4" stroke="#D3D3D3" stroke-width=".6"/><path d="M10 11c2-4 10-4 12 0" fill="#FFFFFF" stroke="#D3D3D3" stroke-width=".6"/>',
    ),
    'paper-bag': svg(
      '<path d="M7 11h18l1.5 18h-21z" fill="#C79D72"/><path d="M7 11l2-3h14l2 3" fill="#B08454"/><path d="M12 11c0-3 1.8-5 4-5s4 2 4 5" stroke="#7D4533" stroke-width="1.4" fill="none"/><path d="M9 16h14" stroke="#A67A4C" stroke-width=".8"/>',
    ),
    'paper-cup': svg(
      '<path d="M8 9h16l-2 20H10z" fill="#FFFFFF" stroke="#D3D3D3" stroke-width=".6"/><path d="M7 7h18v3H7z" fill="#B4ACBC"/><path d="M8.6 15h14.8l-.8 7H9.4z" fill="#C79D72"/><path d="M14 3c-1 1.4 1 2.6 0 4M18 3c-1 1.4 1 2.6 0 4" stroke="#B4ACBC" stroke-width=".9" fill="none" stroke-linecap="round"/>',
    ),

    // the category pictures, made of Fluent ones
    vegetables: svg(fl('carrot', 2, 9, 17) + fl('spinach', 13, 3, 17) + fl('tomato', 11, 14, 17)),
    fruits: svg(fl('apple', 2, 12, 16) + fl('banana', 13, 3, 17) + fl('grapes', 14, 14, 16)),
    spices: svg(
      '<g transform="translate(-4 2) scale(.75)">' +
        drawnInner('star') +
        '</g>' +
        CLOVE(20, 12, 30, 1) +
        CARDAMOM(22, 23, 70) +
        `<g transform="translate(2 14) scale(.5)">${STAR(16, 16, 12)}</g>`,
    ),
    grocery: sack('#C79D72', '#F4F4F4', at(10, 13, 0.4, WHEAT)),
    meat: svg(fl('mutton', 0, 0, 32)),
    seafood: svg(fl('fish', 0, 2, 22) + fl('prawns', 12, 12, 20)),
    dairy: svg(fl('milk', 0, 4, 20) + fl('cheese', 13, 6, 18) + fl('egg', 10, 16, 15)),
    bakery: svg(fl('bread', 0, 6, 22) + fl('croissant', 12, 12, 20)),
    spirits: bottle({
      glass: '#D9F0FF',
      liquid: '#C47A1A',
      cap: '#3F2A20',
      shape: 'spirit',
      label: '#FFFFFF',
    }),
    mixers: can(
      '#00A6ED',
      '#FFFFFF',
      scatter(6, 103, [11, 14, 21, 19])
        .map(
          (g) =>
            `<circle cx="${f(g.x)}" cy="${f(g.y)}" r=".9" fill="none" stroke="#00A6ED" stroke-width=".6"/>`,
        )
        .join(''),
    ),
    'bar-supplies': svg(fl('cocktail', 0, 4, 22) + fl('ice', 14, 14, 17)),
    amenities: svg(fl('soap', 0, 10, 18) + fl('shampoo', 13, 2, 18) + fl('dental-kit', 12, 14, 16)),
    cleaning: svg(fl('broom', 0, 2, 22) + fl('sponge', 14, 14, 17)),
    packaging: svg(fl('box', 0, 0, 32)),
    minibar: svg(fl('chocolate', 0, 6, 20) + fl('peanuts', 14, 12, 17)),
    linen: cloth('#E8ECFF', '#8C9BD9', undefined, 3),
  };
}

// the star anise inside the spices picture
function drawnInner(name: 'star'): string {
  return name === 'star' ? STAR(16, 16, 12) : '';
}
