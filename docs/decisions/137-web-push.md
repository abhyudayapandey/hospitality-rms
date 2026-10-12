# ADR 137: Alerts on the phone (Web Push)

Status: accepted

Notifications lived only in the app's bell (ADR 008: "web push is Phase 2"). Frontline staff
do not sit in the app, so a new task, a published roster or an approval waited until they
next opened it.

- **What is pushed:** every row of `ops.notification`, within about a minute, to each phone its
  owner turned alerts on for. One alert per kind stays on the lock screen (the newer replaces
  it); a tap opens the notification's link. Nothing older than 15 minutes is sent, so a deploy
  or an outage never sends a backlog; the column `pushed_at` marks what was handled (existing
  rows count as handled).
- **Turning it on:** Home asks once ("Get alerts on this phone?" Turn on / Not now, kept on the
  phone); Profile → "Alerts on this phone" turns it on or off any time. An iPhone shows alerts
  only from the app on its Home Screen (iOS 16.4+), so Safari explains how. A phone shared at
  shift change follows whoever is signed in (saving moves it); signing out stops its alerts.
- **Data:** `ops.push_subscription` (NOTIFICATIONS, self: each person reads only their own,
  RPC only, audited). `ops.save_push_subscription` and `ops.remove_push_subscription` for the
  app; `ops.push_due` and `ops.push_result` for the sender only (wf_executor). Only the
  browsers' push services are accepted as endpoints (Google, Apple, Mozilla, Microsoft), in
  the database and again in the sender, so a subscription can never aim the server elsewhere.
  A phone that answers 404/410, or fails five times running, is archived.
- **Sending:** the minute job (wf-execute) after its executor pass, with `web-push` (a new
  dependency: the standard VAPID signing and RFC 8291 encryption) building each request and
  `fetch` sending it. Free: the push services charge nothing, and the payloads are a few KB.
- **Keys:** one SecureString, `web/vapid_private` (64 hex characters, `create-secrets.sh`),
  read only by wf-execute (LoadCredential). `fetch-params.sh` works out the public key with
  openssl for the web, which never holds the private key. Without the parameter nothing is
  pushed and the app offers no alerts; dev, CI and e2e run that way (e2e sets a public key
  only, and stands in for the browser's push subscription).
