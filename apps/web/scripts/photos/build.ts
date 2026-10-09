// Writes the photo library (ADR 084): for each picture key in library.json, the chosen
// Wikimedia Commons photo, cut to its subject on white, as apps/web/public/pictures/<key>.webp;
// then lib/picture-photos.ts (key -> file) and lib/picture-credits.ts (who took each photo and
// its licence, shown under Profile -> Picture credits). Run after changing library.json:
//   pnpm --filter @outlet-ops/web photos
// The files are committed; the app only serves them. Every file on Commons is under a free
// licence; we keep the licence and author of each.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PICTURE_KEYS, pictureOf } from '@outlet-ops/domain';
import sharp from 'sharp';

const WEB = join(import.meta.dirname, '..', '..');
const OUT = join(WEB, 'public', 'pictures');
const CACHE = join(tmpdir(), 'outlet-ops-photo-library');
const UA = 'OutletOpsPictureLibrary/1.0 (https://github.com/abhyudayapandey/hospitality-rms)';
const API = 'https://commons.wikimedia.org/w/api.php';
const SIZE = 320;

/** key -> the Commons file ("File:Garlic.JPG") */
const library = JSON.parse(readFileSync(join(import.meta.dirname, 'library.json'), 'utf8')) as Record<
  string,
  string
>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string): Promise<Response> {
  for (let i = 0; i < 12; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.status !== 429 && res.status !== 503) return res;
    const wait = Number(res.headers.get('retry-after') ?? 20) + 2;
    console.log(`  Commons asks to wait ${wait}s`);
    await sleep(wait * 1000);
  }
  throw new Error(`Commons kept refusing ${url}`);
}

interface Info {
  title: string;
  thumb: string;
  page: string;
  licence: string;
  licenceUrl: string;
  author: string;
}

const plain = (s: string | undefined) =>
  (s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/** Licence, author and a 500 px rendition of each file, 50 files a request. */
async function infos(titles: string[]): Promise<Map<string, Info>> {
  const out = new Map<string, Info>();
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const q = new URLSearchParams({
      action: 'query',
      titles: batch.join('|'),
      prop: 'imageinfo',
      iiprop: 'url|extmetadata',
      iiurlwidth: '500',
      format: 'json',
      formatversion: '2',
    });
    const body = (await (await get(`${API}?${q}`)).json()) as {
      query: {
        normalized?: { from: string; to: string }[];
        pages: {
          title: string;
          missing?: boolean;
          imageinfo?: {
            thumburl: string;
            descriptionurl: string;
            extmetadata: Record<string, { value: string } | undefined>;
          }[];
        }[];
      };
    };
    const asked = new Map(batch.map((t) => [t, t]));
    for (const n of body.query.normalized ?? []) asked.set(n.to, n.from);
    for (const p of body.query.pages) {
      const ii = p.imageinfo?.[0];
      if (p.missing || !ii) throw new Error(`not on Commons: ${p.title}`);
      const md = ii.extmetadata;
      out.set(asked.get(p.title) ?? p.title, {
        title: p.title,
        // thumb.wikimedia.org and upload.wikimedia.org serve the same path
        thumb: ii.thumburl.split('?')[0]!.replace('//thumb.wikimedia.org/', '//upload.wikimedia.org/'),
        page: ii.descriptionurl,
        licence: plain(md.LicenseShortName?.value) || 'see source',
        licenceUrl: plain(md.LicenseUrl?.value),
        author: plain(md.Artist?.value) || plain(md.Credit?.value) || 'Wikimedia Commons',
      });
    }
    await sleep(1000);
  }
  return out;
}

async function bytesOf(info: Info): Promise<Buffer> {
  mkdirSync(CACHE, { recursive: true });
  // the same name the picking script gives a download: the URL's SHA-1
  const name = createHash('sha1').update(info.thumb).digest('hex');
  const cached = join(CACHE, name);
  if (existsSync(cached)) return readFileSync(cached);
  const res = await get(info.thumb);
  if (!res.ok) throw new Error(`${info.title}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(cached, buf);
  await sleep(4000); // Commons limits how fast one client may download
  return buf;
}

/** The subject cut out of its white margins, centred on white with a little room around it. */
async function square(input: Buffer): Promise<Buffer> {
  const flat = await sharp(input).rotate().flatten({ background: '#ffffff' }).toBuffer();
  let trimmed = flat;
  try {
    trimmed = await sharp(flat).trim({ background: '#ffffff', threshold: 28 }).toBuffer();
  } catch {
    // nothing to trim
  }
  const inner = Math.round(SIZE * 0.9);
  const fitted = await sharp(trimmed)
    .resize(inner, inner, { fit: 'inside', withoutEnlargement: false })
    .toBuffer();
  return sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: '#ffffff' } })
    .composite([{ input: fitted, gravity: 'centre' }])
    .webp({ quality: 78 })
    .toBuffer();
}

async function main() {
  const keys = new Set(PICTURE_KEYS);
  const unknown = Object.keys(library).filter((k) => !keys.has(k));
  if (unknown.length) throw new Error(`not in the catalogue: ${unknown.join(', ')}`);

  const info = await infos([...new Set(Object.values(library))]);
  mkdirSync(OUT, { recursive: true });
  for (const f of readdirSync(OUT)) if (f.endsWith('.webp')) rmSync(join(OUT, f));

  const photos: [string, string][] = [];
  const credits: string[] = [];
  for (const [key, title] of Object.entries(library).sort(([a], [b]) => a.localeCompare(b))) {
    const i = info.get(title)!;
    writeFileSync(join(OUT, `${key}.webp`), await square(await bytesOf(i)));
    photos.push([key, `${key}.webp`]);
    credits.push(
      `  { key: ${JSON.stringify(key)}, label: ${JSON.stringify(pictureOf(key)!.label)}, title: ${JSON.stringify(
        i.title.replace(/^File:/, ''),
      )}, author: ${JSON.stringify(i.author)}, licence: ${JSON.stringify(i.licence)}, licenceUrl: ${JSON.stringify(
        i.licenceUrl,
      )}, source: ${JSON.stringify(i.page)} },`,
    );
    console.log(`[photos] ${key}`);
  }

  writeFileSync(
    join(WEB, 'lib', 'picture-photos.ts'),
    `// Written by \`pnpm --filter @outlet-ops/web photos\` from scripts/photos/library.json: do not edit.
// The photo library (ADR 084): picture key -> its file in public/pictures. Real photos of the
// thing itself, shared by every customer; a key with no photo shows its kind's (a brand), else
// the line icon for its kind.
export const PICTURE_PHOTOS: ReadonlyMap<string, string> = new Map<string, string>([
${photos.map(([k, f]) => `  [${JSON.stringify(k)}, ${JSON.stringify(f)}],`).join('\n')}
]);
`,
  );
  writeFileSync(
    join(WEB, 'lib', 'picture-credits.ts'),
    `// Written by \`pnpm --filter @outlet-ops/web photos\`: do not edit.
// Who took each photo in the library and under which licence (all from Wikimedia Commons).
export interface PictureCredit {
  key: string;
  label: string;
  title: string;
  author: string;
  licence: string;
  licenceUrl: string;
  source: string;
}

export const PICTURE_CREDITS: readonly PictureCredit[] = [
${credits.join('\n')}
];
`,
  );
  console.log(`[photos] ${photos.length} written to ${OUT}`);
}

await main();
