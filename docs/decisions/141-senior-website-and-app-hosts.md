# 141. Senior: the website, the app's hosts and demo requests

Date: 2026-10-13. Status: accepted. Migration `20261227100000_demo_requests.sql`.

## Context

The product is now called **Senior**. Restaurant staff use the word for an experienced
colleague whose name they don't know. The brand line is "Log aate jaate rahenge. Senior yahin
rahega." (people come and go; Senior stays). The brand needs:

- a public website that sells the problem it solves, not the software;
- the app on a hostname of its own;
- a way for an owner to ask for a demo.

The app ran at one DuckDNS hostname, and pilot phones have it installed.

## Decision

1. **Two hosts on the one instance, behind the one Caddy** (ADR 005 stands: no new AWS
   hosting):
   - **heysenior.app** is the website: static files from `apps/site/public`, shipped in the
     release bundle as `site/` and served by Caddy's `file_server`. Nothing is built.
   - **my.heysenior.app** is the app: `/login` for staff, `/platform` for the Senior team. A
     signed-out `/` goes to `/login` (the proxy already did this; a test now pins it).
   - **www.heysenior.app** redirects to the apex.
     `infra/cdk.json` has `domainName` (the app), `siteDomain` and `legacyDomains`. Cognito's
     URLs, the photo bucket's CORS and `APP_URL` all follow `domainName`, as before.
2. **The old hostname redirects.** Each `legacyDomains` entry gets a Caddy block that sends
   every request to the same path on the app's hostname with a 308. `fetch-params.sh` writes
   these blocks from the `legacy_domains` parameter, which holds `-` when there are none.
   Installed apps and bookmarks keep working. Removing the entry ends it.
3. **The website's CSP is strict:**
   - `script-src 'self'`, with no inline script or style, and `connect-src 'self'`;
   - Google Fonts are the only outside source.
     `apps/site/site.test.ts` checks the files instead of a build.
4. **Demo requests are the first write with no session.** The form posts to
   `heysenior.app/api/demo-request`, its own origin. Caddy passes that one path to the app;
   the proxy matcher leaves it alone. Five guards:
   - the request's Origin must be `SITE_URL`'s, with `Sec-Fetch-Site: same-origin`;
   - 5 requests an hour per address (`core.rate_limit_hit`);
   - a hidden trap field: a bot that fills it is thanked and dropped;
   - zod (`demoRequestSchema`) checks every field, then the database checks them again;
   - `platform.add_demo_request` refuses more than 100 an hour from everyone together.
     app_rw has no grant on `platform.demo_request`. Only platform admins list requests and
     mark them called back (`platform.demo_requests`, `platform.mark_demo_request_handled`),
     and marking one is in the platform audit.
5. **The team sees requests in the console.** "Demo requests to call back (N)" sits amber on
   the console home. There is no e-mail: an SNS topic is one of the resource types the Free
   plan stack refuses (ADR 005), and the instance has no other way to send mail. When the
   account upgrades, an SNS e-mail or a Web Push to platform admins can be added. The
   `platform.job` queue is the natural place for that.
6. **The app is renamed to Senior where people see it**:
   - the name, its icons (drawn at build time from `lib/senior-mark.ts`) and the sign-in
     screen;
   - alerts, the camera prompts and "Ask the Senior team";
   - the console, the printed login sheet and the invitation e-mail.
     Internal names stay: `@outlet-ops/*`, systemd units, the CDK stack and its resource ids,
     the Cognito domain prefixes and `/outlet-ops/prod` parameters. Renaming those would
     replace AWS resources for no one's benefit.
7. **One mark everywhere.** Senior's mark (glasses with smiling eyes, a moustache, a smile, on
   the brand teal) is `apps/web/public/icon.svg`. The website's `favicon.svg` is the same
   file, and a test keeps them equal. The website's PNGs come from
   `pnpm --filter @outlet-ops/web icons`.

8. **Built for search engines and AI answers.**
   - **Who it's for:** hotels, bars and pubs, restaurants, QSRs, cloud kitchens, central
     kitchens and franchise businesses. The same plain definition opens the home page, the
     FAQ, the structured data and `llms.txt`.
   - **Real pages:** `/`, the six problem pages (`/stock`, `/recipes`, `/roster`,
     `/daily-work`, `/hotel-rooms`, `/licences`), `/what-senior-keeps`, `/plans`, `/faq`,
     `/trust`, `/demo`, `/privacy`, `/terms` and a real 404.
   - **How they are made:** `apps/site/build.ts` writes them from `src/` (layout, parts, pages,
     `faq.json`) into `public/`, which is committed. The test fails if `public/` is stale,
     so nothing builds in CI.
   - **Per page:** a title and description of its own, a canonical URL, share tags, one `h1`,
     and JSON-LD. Every page has `Organization`, `WebSite`, `WebPage` and a breadcrumb; home
     has `SoftwareApplication`; any page showing questions has a `FAQPage`, written from the
     same `faq.json` as the visible answers.
   - **Clean URLs:** `/plans` serves `plans.html`; `/plans.html` and `/index.html` redirect;
     an unknown path is a 404 with the 404 page (no soft 404s).
   - **Fonts:** the site serves its own (SIL Open Font License, `fonts/OFL.txt`), so the CSP
     names no outside host.
   - **Crawlers:** `robots.txt` lets search engines and AI assistants (GPTBot, ClaudeBot,
     PerplexityBot, Google-Extended and others) read everything but `/api/`. `llms.txt`
     summarises Senior and its pages, and the sitemap lists every page.
   - **Franchises:** a demo request may come from a franchise (`franchise` outlet kind).

## Consequences

- **Before deploying:**
  - buy heysenior.app;
  - add A records for `heysenior.app`, `www.heysenior.app` and `my.heysenior.app`, pointing
    at the Elastic IP;
  - keep the DuckDNS record, so the redirect is reached.
    The stack change (Cognito URLs, new parameters) goes out before the app (`docs/deploy.md`).
- `.app` is on the HSTS preload list: every name under it is HTTPS only, which Caddy already
  is.
- A person who signs in on the old hostname is redirected first, so Cognito sees only the
  new URLs.
- Leads are personal data: the website's privacy text says they are kept. The team deletes a
  lead on request (by hand in the database for now; it holds no customer data).
- "Senior" alone is a common word to search for. Keep the name and the one definition the same
  everywhere Senior is listed (Google Business Profile, LinkedIn, Capterra/G2, Crunchbase).
  This lets search engines and AI assistants treat them as one business.
- A word on the website changes in `apps/site/src`, then `pnpm --filter @outlet-ops/site build`;
  bump `UPDATED` in `build.ts` so the sitemap says so.
