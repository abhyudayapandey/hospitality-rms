import { appUrl } from '@/lib/app-url';

// The platform sign-in's last step (ADR 012). The platform cookie is SameSite=Strict, and
// the return from the hosted UI is a navigation started on Cognito's site: the browser
// withholds a Strict cookie on every hop of it, redirects included. This page is served
// on that navigation and then moves on to /platform itself, a navigation that starts on
// our own site, so the cookie goes with it. No input, one fixed target.
export function GET() {
  const to = appUrl('/platform').toString();
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="0;url=${to}"><title>Signing in</title><p style="font-family:system-ui,sans-serif;padding:16px">Signing in… <a href="${to}">Continue</a></p>`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}
