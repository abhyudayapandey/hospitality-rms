import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUTLET_COUNTS, OUTLET_KINDS } from '@outlet-ops/domain';
import { describe, expect, it } from 'vitest';
import { SENIOR_MARK_SVG } from '../web/lib/senior-mark';
import { build, DEFINITION, loadFaqs, loadPages, ORIGIN } from './build';

// The website (ADR 141): static files Caddy serves under a CSP of script-src 'self' with no
// inline style. These checks stand in for a build: the pages are the generated ones; each is
// ready for search engines and AI answers; the copy speaks as Senior.

const pub = join(import.meta.dirname, 'public');
const read = (f: string) => readFileSync(join(pub, f), 'utf8');
const pages = loadPages();
const html = Object.fromEntries(pages.map((p) => [p.file, read(p.file)]));
const js = read('site.js');
const css = read('site.css');
const urlOf = (path: string) => (path === '/' ? `${ORIGIN}/` : `${ORIGIN}${path}`);
const text = (s: string) =>
  s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>|<[^>]+>/g, ' ');
const attr = (page: string, re: RegExp) => re.exec(page)?.[1];
type Graph = { '@context': string; '@graph': Record<string, unknown>[] };
const ldOf = (page: string) =>
  [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
    (m) => JSON.parse(m[1]!) as Graph,
  );
const unesc = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

describe('the generated website', () => {
  it('public/ is what build.ts makes from src/ (run: pnpm --filter @outlet-ops/site build)', () => {
    for (const [name, content] of Object.entries(build())) expect(read(name), name).toBe(content);
  });

  it('has the pages search and AI answers need, each at its own clean URL', () => {
    expect(pages.map((p) => p.meta.path).sort()).toEqual(
      [
        '/',
        '/404',
        '/daily-work',
        '/demo',
        '/faq',
        '/hotel-rooms',
        '/licences',
        '/plans',
        '/privacy',
        '/recipes',
        '/roster',
        '/stock',
        '/terms',
        '/trust',
        '/what-senior-keeps',
      ].sort(),
    );
  });

  it('every page has its own title and description', () => {
    const titles = pages.map((p) => p.meta.title);
    const descriptions = pages.map((p) => p.meta.description);
    expect(new Set(titles).size).toBe(titles.length);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });
});

describe.each(pages.map((p) => [p.meta.path, p] as const))('page %s', (path, p) => {
  const page = html[p.file]!;

  it('has one h1, a title and description of the right length, and its canonical URL', () => {
    expect(page.match(/<h1[\s>]/g)).toHaveLength(1);
    const title = unesc(attr(page, /<title>([^<]+)<\/title>/)!);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title).toMatch(/Senior/);
    const description = unesc(attr(page, /<meta name="description" content="([^"]+)"/)!);
    expect(description.length).toBeGreaterThanOrEqual(70);
    expect(description.length).toBeLessThanOrEqual(160);
    expect(attr(page, /<link rel="canonical" href="([^"]+)"/)).toBe(urlOf(path));
    expect(attr(page, /<meta property="og:url" content="([^"]+)"/)).toBe(urlOf(path));
    expect(page).toContain('<meta property="og:image" content="https://heysenior.app/og.png"');
    expect(page).toContain('<html lang="en-IN">');
    expect(attr(page, /<meta name="robots" content="([^"]+)"/)).toBe(
      p.meta.notFound ? 'noindex' : 'index, follow',
    );
  });

  it('has structured data: Senior, the site, the page, and its questions as shown', () => {
    const [ld, ...more] = ldOf(page);
    expect(more).toEqual([]);
    expect(ld!['@context']).toBe('https://schema.org');
    const types = ld!['@graph'].map((n) => n['@type']);
    expect(types).toEqual(expect.arrayContaining(['Organization', 'WebSite', 'WebPage']));
    if (path !== '/') expect(types).toContain('BreadcrumbList');
    const faq = ld!['@graph'].find((n) => n['@type'] === 'FAQPage') as
      { mainEntity: { name: string; acceptedAnswer: { text: string } }[] } | undefined;
    const visible = [...page.matchAll(/<summary>([^<]+)<\/summary><p>([^<]+)<\/p>/g)].map((m) => [
      unesc(m[1]!),
      unesc(m[2]!),
    ]);
    expect((faq?.mainEntity ?? []).map((q) => [q.name, q.acceptedAnswer.text])).toEqual(visible);
    expect(visible.length).toBe((p.meta.faq ?? []).length);
  });

  it('links only to pages and files that exist, with no #page routing', () => {
    const hrefs = [...page.matchAll(/(?:href|src)="(\/[^"#?]*)/g)].map((m) => m[1]!);
    expect(hrefs.length).toBeGreaterThan(5);
    const paths = new Set(pages.map((q) => q.meta.path));
    for (const h of hrefs) expect(paths.has(h) || existsSync(join(pub, h)), h).toBe(true);
    expect(page).not.toMatch(/href="#(home|keeps|plans|trust|demo|privacy|terms)"/);
  });

  it('has no inline script but its data, no inline style, nothing from outside hosts', () => {
    expect(page.match(/<script\b[^>]*>/g)).toEqual([
      '<script src="/site.js" defer>',
      '<script type="application/ld+json">',
    ]);
    expect(page).not.toMatch(/\sstyle="/);
    expect(page).not.toMatch(/\son[a-z]+="/);
    // nothing loads from elsewhere: outside links (the facts' sources) are only <a>s
    expect(page).not.toMatch(/\ssrc="https?:\/\//);
    for (const link of page.match(/<link\b[^>]*>/g) ?? []) {
      expect(link).not.toMatch(/href="https?:\/\/(?!heysenior\.app\/)/);
    }
  });

  it('speaks as Senior: no old name and no software words', () => {
    expect(text(page)).not.toMatch(/Outlet Ops|SaaS|platform|AI-powered|prototype/i);
  });
});

describe('what Senior is, for search and AI answers', () => {
  const home = html['index.html']!;

  it('says plainly, under the headline, what Senior is and who it is for', () => {
    expect(home).toContain(`<p class="what">${DEFINITION}</p>`);
    for (const who of ['hotels', 'bars', 'restaurants', 'QSRs', 'cloud kitchens', 'franchise']) {
      expect(DEFINITION, who).toContain(who);
    }
    const app = ldOf(home)[0]!['@graph'].find((n) => n['@type'] === 'SoftwareApplication');
    expect(app).toMatchObject({ name: 'Senior', description: DEFINITION });
  });

  it('every question in the FAQ is on /faq, and none is on a page twice', () => {
    const faq = text(html['faq.html']!);
    for (const f of loadFaqs()) expect(unesc(faq)).toContain(f.q);
    for (const p of pages) expect(new Set(p.meta.faq).size).toBe((p.meta.faq ?? []).length);
  });

  it('lists every page but 404 in the sitemap, which robots.txt names', () => {
    const locs = [...read('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(pages.filter((p) => !p.meta.notFound).map((p) => urlOf(p.meta.path)));
    const robots = read('robots.txt');
    expect(robots).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
    for (const bot of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', '*']) {
      expect(robots).toContain(`User-agent: ${bot}\nAllow: /\nDisallow: /api/\n`);
    }
  });

  it('llms.txt says what Senior is and links every page', () => {
    const llms = read('llms.txt');
    expect(llms.startsWith(`# Senior\n\n> ${DEFINITION}\n`)).toBe(true);
    for (const p of pages.filter((q) => !q.meta.notFound)) {
      expect(llms).toContain(`(${urlOf(p.meta.path)})`);
    }
  });
});

describe('the website files', () => {
  it('serves its own fonts, with their licence', () => {
    const fonts = [...css.matchAll(/url\('(\/fonts\/[^']+)'\)/g)].map((m) => m[1]!);
    expect(fonts).toHaveLength(7);
    for (const f of fonts) expect(existsSync(join(pub, f)), f).toBe(true);
    expect(read('fonts/OFL.txt').match(/SIL OPEN FONT LICENSE/g)).toHaveLength(3);
    expect(css + Object.values(html).join('')).not.toMatch(/googleapis|gstatic/);
  });

  it('[hidden] hides anything, since the script shows the thanks with it; nothing routes', () => {
    const flat = css.replace(/\s+/g, ' ');
    expect(flat).toContain('[hidden] { display: none !important; }');
    expect(flat).toMatch(/body \{ margin: 0; \}/);
    expect(js).not.toMatch(/\sstyle="/);
    expect(js).not.toMatch(/location\.hash|hashchange/);
  });

  it('every picture the app screens show exists', () => {
    const items = [...js.matchAll(/item\('([a-z]+)'/g)].map((m) => m[1]!);
    expect(items.length).toBeGreaterThan(3);
    for (const img of items) expect(existsSync(join(pub, 'img', `${img}.webp`)), img).toBe(true);
  });

  it('sends people who sign in to the app, my.heysenior.app/login', () => {
    for (const page of Object.values(html)) {
      expect(page).toContain('href="https://my.heysenior.app/login">Sign in</a>');
      expect(page).not.toContain('duckdns');
    }
  });

  it('the demo form posts to its own origin, with a trap for bots and the choices the server takes', () => {
    const demo = html['demo.html']!;
    expect(js).toContain("fetch('/api/demo-request'");
    for (const id of ['demoForm', 'formErr', 'f-send', 'thanks', 'tName', 'tPhone', 'f-website']) {
      expect(demo, id).toContain(`id="${id}"`);
    }
    expect(demo).toMatch(
      /<div class="hp" aria-hidden="true">[\s\S]*?name="website"\s+tabindex="-1"/,
    );
    const options = (name: string) =>
      [
        ...new RegExp(`name="${name}"[^>]*>([\\s\\S]*?)</select>`)
          .exec(demo)![1]!
          .matchAll(/<option>([^<]+)<\/option>/g),
      ].map((m) => unesc(m[1]!));
    expect(options('type')).toEqual(Object.keys(OUTLET_KINDS));
    expect(options('outlets')).toEqual(Object.keys(OUTLET_COUNTS));
  });

  it('its favicon is the app icon: the same mark', () => {
    expect(read('favicon.svg')).toBe(SENIOR_MARK_SVG);
    expect(readFileSync(join(import.meta.dirname, '..', 'web', 'public', 'icon.svg'), 'utf8')).toBe(
      SENIOR_MARK_SVG,
    );
  });
});
