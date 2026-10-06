# 063 — No blank screen when the server or Cognito is slow

Status: accepted · 2026-10-06

## Context

On 6 Oct, between 9:05 and 9:10 pm IST, the app on an iPhone on Wi-Fi showed a white screen
for over a minute, then bare "Offline" text.

- The server's log showed no restart and no error at that time. A deploy had restarted it 7
  minutes earlier, at 8:58 pm.
- From the server, Cognito answered in 0.03 s.
- So the phone's page request never got an answer, and nothing on the phone said so.

We found three gaps:

1. **Caddy offered HTTP/3.** It does this by default, but the security group opens TCP 443,
   not UDP 443. A phone that remembers the offer tries a connection that can't open; iPhones
   can stall on it.
2. **The service worker waited without limit.** It waited as long as the browser did, then
   showed a plain "Offline" response. The cached offline page it meant to show had been
   deleted at sign-out.
3. **The hourly Cognito re-check had no time limit.** It runs in the request middleware
   before any page, so a slow Cognito would hold every page. Any failure, including Cognito
   not answering, signed the person out.

There were no request logs, so what happened could only be inferred.

## Decision

1. **HTTP/1.1 and HTTP/2 only** (`servers { protocols h1 h2 }` in the Caddyfile). This matches
   the security group. HTTP/3 can come back with a UDP 443 rule if it is ever wanted.
2. **The service worker gives a page 10 seconds to start arriving.**
   - After that, or when it can't be fetched at all, the worker shows "Can't reach Outlet
     Ops" with **Try again**.
   - That screen retries by itself every 10 seconds and when the phone comes back online.
   - The screen is built into the worker, so no cache can be missing or stale. The worker
     caches nothing, and deletes the old cache.
   - Sign-in round trips (`/auth/`, `/platform/auth/`) and `/api/` get no time limit.
3. **Calls to Cognito give up after 5 seconds.**
   - Cognito not answering (no connection, a timeout, a 5xx or 429) says nothing about the
     session. The person carries on, and the check runs again on the next request, for up to
     24 hours (`COGNITO_GRACE_S`).
   - A rejection (a revoked or expired refresh token) still signs them out.
4. **Logs.**
   - Caddy writes one line per request to the journal (`journalctl -u outlet-ops-caddy`):
     method, path, status and duration. Request and response headers, cookies included, are
     left out.
   - The server logs `cognito_unavailable`, `cognito_refresh_rejected` and
     `cognito_refresh_slow` (over 2 s), with how long the call took.

## Consequences

- **A slow or unreachable server shows a clear screen within about 10 seconds**, and the app
  comes back by itself.
- **A Cognito outage no longer signs everyone out** or holds every page for minutes. Security
  is unchanged: a revoked session is still refused within the hour, as before.
- **Next time, the logs can say what happened** instead of leaving it to be inferred.
- **Tests:** `slow-cognito.test.ts` (Cognito hangs, is down, rejects, the 24-hour cap),
  `cognito.test.ts` (the 5-second limit, a 5xx versus a 400), and `e2e/slow-start.spec.ts`
  (offline, and a server that doesn't answer, at 380 px).
