// Builds the website (ADR 141) from src/ into public/: one HTML page per path, each with its
// own title, description, canonical URL, share tags and structured data, plus sitemap.xml,
// robots.txt and llms.txt. The output is committed; site.test.ts fails if it is stale.
//   pnpm --filter @outlet-ops/site build
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ORIGIN = 'https://heysenior.app';
/** The sitemap's lastmod: change it when a page's words change. */
export const UPDATED = '2026-10-14';
/** What Senior is, in one plain answer: the home page, every page's schema and llms.txt. */
export const DEFINITION =
  'Senior is an app for hotels, bars, restaurants, QSRs, cloud kitchens and franchise businesses. It runs stock, recipes, rosters, attendance, checklists and licences from every staff phone.';
export const AUDIENCE =
  'Hotels, bars and pubs, restaurants, QSRs, cloud kitchens, central kitchens and franchise businesses';

export interface PageMeta {
  path: string;
  title: string;
  description: string;
  /** the page's name in the breadcrumb and llms.txt */
  crumb: string;
  /** FAQ ids from src/faq.json, shown where the page says {{faq}} */
  faq?: string[];
  /** the home page describes the app itself */
  software?: boolean;
  /** the 404 page: not in the sitemap, not indexed */
  notFound?: boolean;
}

export interface Faq {
  id: string;
  q: string;
  a: string;
}

export interface Page {
  meta: PageMeta;
  body: string;
  file: string;
}

const src = join(import.meta.dirname, 'src');
const read = (p: string) => readFileSync(join(src, p), 'utf8');

export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function loadFaqs(): Faq[] {
  return JSON.parse(read('faq.json')) as Faq[];
}

/** A page source starts with <!--page {json}--> and the rest is its body. */
export function loadPages(): Page[] {
  return readdirSync(join(src, 'pages'))
    .filter((f) => f.endsWith('.html'))
    .sort()
    .map((f) => {
      const text = read(join('pages', f));
      const m = /^<!--page (\{[\s\S]*?\})-->\n/.exec(text);
      if (!m) throw new Error(`${f}: no <!--page {...}--> header`);
      const meta = JSON.parse(m[1]!) as PageMeta;
      const file = meta.path === '/' ? 'index.html' : `${meta.path.slice(1)}.html`;
      return { meta, body: text.slice(m[0].length), file };
    });
}

const urlOf = (path: string) => (path === '/' ? `${ORIGIN}/` : `${ORIGIN}${path}`);

/** Questions and answers; on /faq itself every answer is open, so it reads as a page. */
export function faqHtml(items: Faq[], open = false): string {
  return (
    '<div class="faq">\n' +
    items
      .map(
        (f) =>
          `<details${open ? ' open' : ''}><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`,
      )
      .join('\n') +
    '\n</div>'
  );
}

/** The page's structured data: who we are, the site, the page, and what it holds. */
export function jsonLd(meta: PageMeta, faqs: Faq[]): Record<string, unknown> {
  const url = urlOf(meta.path);
  const org = {
    '@type': 'Organization',
    '@id': `${ORIGIN}/#org`,
    name: 'Senior',
    alternateName: ['Hey Senior', 'heysenior.app'],
    url: `${ORIGIN}/`,
    logo: `${ORIGIN}/apple-touch-icon.png`,
    description: DEFINITION,
    areaServed: { '@type': 'Country', name: 'India' },
  };
  const site = {
    '@type': 'WebSite',
    '@id': `${ORIGIN}/#website`,
    url: `${ORIGIN}/`,
    name: 'Senior',
    alternateName: 'Hey Senior',
    publisher: { '@id': `${ORIGIN}/#org` },
    inLanguage: 'en-IN',
  };
  const graph: Record<string, unknown>[] = [
    org,
    site,
    {
      '@type': 'WebPage',
      '@id': url,
      url,
      name: meta.title,
      description: meta.description,
      isPartOf: { '@id': `${ORIGIN}/#website` },
      about: { '@id': `${ORIGIN}/#org` },
      inLanguage: 'en-IN',
    },
  ];
  if (meta.path !== '/') {
    graph.push({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Senior', item: `${ORIGIN}/` },
        { '@type': 'ListItem', position: 2, name: meta.crumb, item: url },
      ],
    });
  }
  if (meta.software) {
    graph.push({
      '@type': 'SoftwareApplication',
      '@id': `${ORIGIN}/#app`,
      name: 'Senior',
      alternateName: 'Hey Senior',
      url: `${ORIGIN}/`,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web, Android, iOS (installs from the browser)',
      description: DEFINITION,
      audience: { '@type': 'BusinessAudience', audienceType: AUDIENCE },
      areaServed: { '@type': 'Country', name: 'India' },
      publisher: { '@id': `${ORIGIN}/#org` },
      inLanguage: 'en-IN',
    });
  }
  if (faqs.length > 0) {
    graph.push({
      '@type': 'FAQPage',
      '@id': `${url}#faq`,
      mainEntity: faqs.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    });
  }
  return { '@context': 'https://schema.org', '@graph': graph };
}

function render(page: Page, faqsById: Map<string, Faq>): string {
  const { meta } = page;
  const faqs = (meta.faq ?? []).map((id) => {
    const f = faqsById.get(id);
    if (!f) throw new Error(`${page.file}: no FAQ "${id}"`);
    return f;
  });
  const body = page.body
    .replaceAll('{{faq}}', faqHtml(faqs, meta.path === '/faq'))
    .replaceAll('{{definition}}', esc(DEFINITION));
  // the menu marks where you are
  const header = read('parts/header.html').replace(
    new RegExp(`(<nav[\\s\\S]*?)href="${meta.path}"`),
    `$1href="${meta.path}" aria-current="page"`,
  );
  const ld = JSON.stringify(jsonLd(meta, faqs)).replace(/</g, '\\u003c');
  return read('layout.html')
    .replaceAll('{{title}}', esc(meta.title))
    .replaceAll('{{description}}', esc(meta.description))
    .replaceAll('{{url}}', urlOf(meta.path))
    .replace('{{robots}}', meta.notFound ? 'noindex' : 'index, follow')
    .replace('{{jsonld}}', `<script type="application/ld+json">${ld}</script>`)
    .replace('{{defs}}', read('parts/defs.html'))
    .replace('{{header}}', header)
    .replace('{{footer}}', read('parts/footer.html').replaceAll('{{definition}}', esc(DEFINITION)))
    .replace('{{body}}', body);
}

const AI_AND_SEARCH = [
  'Googlebot',
  'Bingbot',
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-SearchBot',
  'PerplexityBot',
  'Google-Extended',
  'Applebot-Extended',
];

/** Every file the build writes into public/, by name. */
export function build(): Record<string, string> {
  const faqs = loadFaqs();
  const byId = new Map(faqs.map((f) => [f.id, f]));
  const pages = loadPages();
  const out: Record<string, string> = {};
  for (const p of pages) out[p.file] = render(p, byId);
  const listed = pages.filter((p) => !p.meta.notFound);

  out['sitemap.xml'] =
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    listed
      .map((p) => `  <url><loc>${urlOf(p.meta.path)}</loc><lastmod>${UPDATED}</lastmod></url>`)
      .join('\n') +
    '\n</urlset>\n';

  const group = (agent: string) => `User-agent: ${agent}\nAllow: /\nDisallow: /api/\n`;
  out['robots.txt'] =
    '# heysenior.app (ADR 141): search engines and AI assistants may read the whole website.\n' +
    '# /api/ is the demo form, not a page.\n\n' +
    [...AI_AND_SEARCH, '*'].map(group).join('\n') +
    `\nSitemap: ${ORIGIN}/sitemap.xml\n`;

  out['llms.txt'] =
    `# Senior\n\n> ${DEFINITION}\n\n` +
    'Senior is called Senior because it does what an outlet\'s most experienced person does: it remembers the recipes, pars, licence dates and handovers, reminds the right person, and asks before it acts. A person approves every order and change it suggests. Its line is "Log aate jaate rahenge. Senior yahin rahega." (People come and go. Senior stays.)\n\n' +
    `- Website: ${ORIGIN}/\n- The app (for signed-in staff): https://my.heysenior.app\n- Who it is for: ${AUDIENCE}\n- Where: India; data kept on AWS in Mumbai\n\n` +
    '## Pages\n\n' +
    listed
      .map((p) => `- [${p.meta.crumb}](${urlOf(p.meta.path)}): ${p.meta.description}`)
      .join('\n') +
    '\n\n## Questions\n\n' +
    faqs.map((f) => `### ${f.q}\n\n${f.a}\n`).join('\n');
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pub = join(import.meta.dirname, 'public');
  for (const [name, text] of Object.entries(build())) {
    writeFileSync(join(pub, name), text);
    console.log('wrote public/' + name);
  }
}
