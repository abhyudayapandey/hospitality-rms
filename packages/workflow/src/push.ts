import { createECDH } from 'node:crypto';
import webpush from 'web-push';

// Web Push (ADR 137): each new notification goes to its owner's phones through the browsers'
// own push services (Google, Apple, Mozilla, Microsoft), encrypted for that phone and signed
// with our VAPID key. Run by the minute job as wf_executor, after the executor's pass.

/** The VAPID key pair from the private key's 64 hex characters (as SSM keeps it). */
export function vapidKeys(privateHex: string): { publicKey: string; privateKey: string } {
  if (!/^[0-9a-f]{64}$/i.test(privateHex)) throw new Error('VAPID key must be 64 hex characters');
  const d = Buffer.from(privateHex, 'hex');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: d.toString('base64url'),
  };
}

/** The push services browsers use; nothing else is ever sent to (as ops.push_endpoint_ok). */
export function pushEndpointOk(endpoint: string): boolean {
  return (
    endpoint.length <= 1000 &&
    /^https:\/\/(fcm\.googleapis\.com|web\.push\.apple\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com)\//.test(
      endpoint,
    )
  );
}

export interface DuePush {
  notification_id: string;
  subscription_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
}

/** What the service worker shows: the title, the body, where a tap goes; one per kind. */
export function pushPayload(p: Pick<DuePush, 'kind' | 'title' | 'body' | 'link'>): string {
  return JSON.stringify({
    title: p.title,
    body: p.body ?? '',
    link: p.link && p.link.startsWith('/') ? p.link : '/',
    tag: p.kind,
  });
}

interface Db {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface PushOptions {
  /** 64 hex characters (VAPID_PRIVATE_KEY) */
  privateHex: string;
  /** mailto: or https: contact for the push services (VAPID_SUBJECT) */
  subject: string;
  log?: (msg: string) => void;
  limit?: number;
  /** tests only: where a push service's endpoint is really sent */
  rewrite?: (endpoint: string) => string;
}

export interface PushResult {
  sent: number;
  gone: number;
  failed: number;
}

const BATCH = 10;

/** Sends what is due (ops.push_due) and records each phone's answer (ops.push_result). */
export async function sendPushes(db: Db, o: PushOptions): Promise<PushResult> {
  const keys = vapidKeys(o.privateHex);
  const due = (
    await db.query<DuePush>(
      `select notification_id::text, subscription_id::text, endpoint, p256dh, auth, kind,
              title, body, link
         from ops.push_due($1)`,
      [o.limit ?? 200],
    )
  ).rows;
  const result: PushResult = { sent: 0, gone: 0, failed: 0 };
  for (let i = 0; i < due.length; i += BATCH) {
    const answers = await Promise.all(
      due.slice(i, i + BATCH).map(async (p) => {
        if (!pushEndpointOk(p.endpoint)) return 'gone' as const;
        try {
          // web-push encrypts and signs; fetch sends (and times out) the request itself
          const req = webpush.generateRequestDetails(
            { endpoint: p.endpoint, keys: { p256dh: p.p256dh, auth: p.auth } },
            pushPayload(p),
            {
              vapidDetails: { subject: o.subject, ...keys },
              TTL: 3600,
              urgency: 'high',
              contentEncoding: 'aes128gcm',
            },
          );
          const res = await fetch(o.rewrite ? o.rewrite(req.endpoint) : req.endpoint, {
            method: req.method,
            headers: req.headers as Record<string, string>,
            body: req.body ? new Uint8Array(req.body) : null,
            signal: AbortSignal.timeout(10_000),
          });
          if (res.status === 404 || res.status === 410) return 'gone' as const;
          return res.ok ? ('sent' as const) : ('failed' as const);
        } catch {
          return 'failed' as const;
        }
      }),
    );
    for (const [j, a] of answers.entries()) {
      result[a] += 1;
      await db.query('select ops.push_result($1, $2, $3)', [
        due[i + j]!.subscription_id,
        a === 'sent',
        a === 'gone',
      ]);
    }
  }
  if (due.length > 0) {
    o.log?.(`push sent=${result.sent} gone=${result.gone} failed=${result.failed}`);
  }
  return result;
}
