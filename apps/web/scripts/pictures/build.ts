// Writes apps/web/public/pictures/<key>.svg for every picture in the catalogue (ADR 084):
// Fluent Emoji's flat SVG for those that name one (fetched from GitHub once, cached under
// the system temp folder), the drawn ones from drawn.ts. Run after changing the catalogue:
//   pnpm --filter @outlet-ops/web pictures
// The files are committed; the app only serves them.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PICTURES, pictureOf } from '@outlet-ops/domain';
import { drawn } from './drawn';

const OUT = join(import.meta.dirname, '..', '..', 'public', 'pictures');
const CACHE = join(tmpdir(), 'outlet-ops-fluent-emoji');
const BASE = 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets';

const fileOf = (folder: string) =>
  `${BASE}/${encodeURIComponent(folder)}/Flat/${folder.toLowerCase().replace(/[ -]/g, '_')}_flat.svg`;

async function fluentSvg(folder: string): Promise<string> {
  mkdirSync(CACHE, { recursive: true });
  const cached = join(CACHE, `${folder}.svg`);
  if (existsSync(cached)) return readFileSync(cached, 'utf8');
  const res = await fetch(fileOf(folder));
  if (!res.ok) throw new Error(`Fluent Emoji "${folder}": ${res.status} from ${fileOf(folder)}`);
  const text = await res.text();
  writeFileSync(cached, text);
  return text;
}

const inner = (s: string) =>
  s
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .trim();

async function main() {
  const fluent = new Map<string, string>();
  for (const p of PICTURES) if (p.fluent) fluent.set(p.key, await fluentSvg(p.fluent));

  // a Fluent picture (by key) placed inside a drawn one
  const fl = (key: string, x: number, y: number, size: number) => {
    const s = fluent.get(key);
    if (!s)
      throw new Error(
        `no Fluent picture "${key}" (${pictureOf(key) ? 'drawn, not Fluent' : 'unknown key'})`,
      );
    return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 32 32">${inner(s)}</svg>`;
  };
  const drawnSvgs = drawn(fl);

  mkdirSync(OUT, { recursive: true });
  for (const name of readdirSync(OUT)) if (name.endsWith('.svg')) rmSync(join(OUT, name));
  const missing: string[] = [];
  for (const p of PICTURES) {
    const body = p.fluent ? fluent.get(p.key) : drawnSvgs[p.key];
    if (!body) {
      missing.push(p.key);
      continue;
    }
    writeFileSync(join(OUT, `${p.key}.svg`), body.endsWith('\n') ? body : `${body}\n`);
  }
  const extra = Object.keys(drawnSvgs).filter((k) => !pictureOf(k));
  if (missing.length || extra.length) {
    throw new Error(
      `pictures missing: ${missing.join(', ') || 'none'}; drawn but not in the catalogue: ${extra.join(', ') || 'none'}`,
    );
  }
  console.log(
    `[pictures] ${PICTURES.length} written to ${OUT} (${fluent.size} Fluent Emoji, ${PICTURES.length - fluent.size} drawn)`,
  );
}

await main();
