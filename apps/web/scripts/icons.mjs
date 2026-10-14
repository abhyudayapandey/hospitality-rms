// Makes the website's icons and share picture from Senior's mark (ADR 141), once, by hand:
//   pnpm --filter @outlet-ops/web icons
// The source is public/icon.svg; the PNGs are committed. The app's own icons are drawn at
// build time (lib/app-icon.tsx). sharp is already a dependency.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const web = join(import.meta.dirname, '..');
const site = join(web, '..', 'site', 'public');
const mark = readFileSync(join(web, 'public', 'icon.svg'), 'utf8');
const figure = readFileSync(join(import.meta.dirname, 'senior-figure.svg'), 'utf8');
const TEAL = '#1f5f57';

// The mark's drawing without its rounded tile, to place on a square of any size.
const inner = mark.replace(/<svg[^>]*>|<\/svg>|<!--[\s\S]*?-->/g, '').replace(/<rect[^>]*\/>/, '');
const square = (size, scale) => {
  const s = (120 * (1 - scale)) / 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${size}" height="${size}">` +
      `<rect width="120" height="120" fill="${TEAL}"/>` +
      `<g transform="translate(${s} ${s}) scale(${scale})">${inner}</g></svg>`,
  );
};
const png = (svg) => sharp(svg).png({ compressionLevel: 9 }).toBuffer();

const out = {
  [join(site, 'favicon-32.png')]: Buffer.from(
    mark.replace('<svg ', '<svg width="32" height="32" '),
  ),
  [join(site, 'apple-touch-icon.png')]: square(180, 0.86),
  [join(site, 'og.png')]: Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">` +
      `<rect width="1200" height="630" fill="#f2f5f2"/>` +
      `<path d="M790 630 V250 a200 200 0 0 1 400 0 V630 Z" fill="#dcebe6"/>` +
      `<svg x="760" y="110" width="416" height="520" viewBox="0 0 240 300">${figure.replace(/<svg[^>]*>|<\/svg>|<!--[\s\S]*?-->/g, '')}</svg>` +
      `<svg x="80" y="80" width="96" height="96" viewBox="0 0 120 120">${mark.replace(/<svg[^>]*>|<\/svg>|<!--[\s\S]*?-->/g, '')}</svg>` +
      `<text x="196" y="148" font-family="Helvetica, Arial, sans-serif" font-size="64" font-weight="800" fill="#12201d">Senior</text>` +
      `<text font-family="Helvetica, Arial, sans-serif" font-size="58" font-weight="800" fill="#12201d">` +
      `<tspan x="80" y="300">Log aate jaate</tspan><tspan x="80" y="370">rahenge.</tspan>` +
      `<tspan x="80" y="440" fill="${TEAL}">Senior yahin</tspan><tspan x="80" y="510" fill="${TEAL}">rahega.</tspan></text>` +
      `<text x="80" y="570" font-family="Helvetica, Arial, sans-serif" font-size="28" fill="#4b5a56">heysenior.app</text>` +
      `</svg>`,
  ),
};

for (const [file, svg] of Object.entries(out)) {
  writeFileSync(file, await png(svg));
  console.log('wrote', file.slice(web.length - 'apps/web'.length));
}
