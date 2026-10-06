// Outlet Ops service worker (ADR 004, 063). Makes the app installable. It never caches
// authenticated pages or API responses. A page that doesn't start arriving within 10 s, or
// can't be fetched at all, gets the "Can't reach Outlet Ops" screen below, which retries by
// itself; the screen lives in this file, so nothing cached can go missing (sign-out deletes
// every cache) or go stale after a deploy.
const TIMEOUT_MS = 10000;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // caches from older versions (the old offline page) are no longer used
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const OFFLINE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f172a">
<title>Can't reach Outlet Ops</title>
<style>
  :root { color-scheme: dark light; }
  body { margin: 0; min-height: 100dvh; display: flex; align-items: center; justify-content: center;
         font: 16px/1.5 system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; }
  main { max-width: 22rem; padding: 1.5rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1.5rem; color: #94a3b8; }
  button { width: 100%; min-height: 3.5rem; border: 0; border-radius: .75rem; font-size: 1.125rem;
           font-weight: 600; background: #4f46e5; color: #fff; }
  small { display: block; margin-top: 1rem; color: #64748b; }
</style></head>
<body><main>
  <h1>Can't reach Outlet Ops</h1>
  <p>Check the Wi-Fi or mobile data. We'll keep trying.</p>
  <button id="retry" type="button">Try again</button>
  <small id="next"></small>
</main>
<script>
  var wait = 10;
  var next = document.getElementById('next');
  function retry() { location.reload(); }
  document.getElementById('retry').addEventListener('click', retry);
  addEventListener('online', retry);
  setInterval(function () {
    wait -= 1;
    if (wait <= 0) retry();
    else next.textContent = 'Trying again in ' + wait + ' s';
  }, 1000);
</script>
</body></html>`;

const offline = () =>
  new Response(OFFLINE_HTML, {
    status: 503,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });

// Paths that may take longer than a screen: sign-in round trips and downloads.
const NO_TIMEOUT = /^\/(auth|api|platform\/auth)\//;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.mode !== 'navigate') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (NO_TIMEOUT.test(url.pathname)) {
    event.respondWith(fetch(req).catch(offline));
    return;
  }
  event.respondWith(
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(offline()), TIMEOUT_MS);
      fetch(req).then(
        (res) => {
          clearTimeout(timer);
          resolve(res);
        },
        () => {
          clearTimeout(timer);
          resolve(offline());
        },
      );
    }),
  );
});
