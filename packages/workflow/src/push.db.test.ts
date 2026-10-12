import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  actAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  resetRole,
  type SeedIds,
} from '@outlet-ops/db/test-helpers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendPushes, vapidKeys } from './push';

// Web Push end to end (ADR 137): a stand-in push service on localhost receives what the sender
// sends for a real notification, as the sender's database role, and decrypts it with the
// phone's own keys (RFC 8291), so the payload and the VAPID signature are what a phone gets.

const PRIVATE = 'c'.repeat(64);
let ids: SeedIds;
let server: Server;
let base = '';
let answer = 201;
const received: { path: string; headers: IncomingHttpHeaders; body: Buffer }[] = [];

beforeAll(async () => {
  ids = await loadSeedIds();
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(answer).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closePools();
});

/** A phone: its key pair and auth secret, as a browser's PushSubscription has them. */
function phone() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    auth,
    p256dh: ecdh.getPublicKey().toString('base64url'),
    authB64: auth.toString('base64url'),
  };
}

/** What the phone does with an aes128gcm push (RFC 8188, 8291). */
function decrypt(p: ReturnType<typeof phone>, body: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const serverPub = body.subarray(21, 21 + idlen);
  const data = body.subarray(21 + idlen);
  const secret = p.ecdh.computeSecret(serverPub);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), p.ecdh.getPublicKey(), serverPub]);
  const ikm = Buffer.from(hkdfSync('sha256', secret, p.auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString('utf8');
}

describe('sending a push', () => {
  it('a notification reaches the phone, encrypted for it and signed with our key', async () => {
    await inRolledBackTx(async (c) => {
      const me = phone();
      const steward = ids.user('test.steward.1.0');
      await c.query(`update ops.notification set pushed_at = now() where pushed_at is null`);
      const endpoint = 'https://fcm.googleapis.com/fcm/send/steward-phone';
      const sub = await c.query<{ id: string }>(
        `insert into ops.push_subscription (tenant_id, owner_user_id, endpoint, p256dh, auth)
         select tenant_id, id, $2, $3, $4 from core.app_user where id = $1 returning id`,
        [steward, endpoint, me.p256dh, me.authB64],
      );
      await c.query(
        `insert into ops.notification (tenant_id, owner_user_id, kind, title, body, link)
         select tenant_id, id, 'roster_published', 'Your roster is published', 'Week of 19 Oct',
                '/roster/my' from core.app_user where id = $1`,
        [steward],
      );
      received.length = 0;
      answer = 201;
      await actAs(c, 'wf_executor', null);
      const r = await sendPushes(c, {
        privateHex: PRIVATE,
        subject: 'mailto:ops@example.com',
        rewrite: (e) => e.replace('https://fcm.googleapis.com', base),
      });
      await resetRole(c);
      expect(r).toEqual({ sent: 1, gone: 0, failed: 0 });
      expect(received).toHaveLength(1);
      const got = received[0]!;
      expect(got.path).toBe('/fcm/send/steward-phone');
      expect(got.headers['content-encoding']).toBe('aes128gcm');
      expect(got.headers['ttl']).toBe('3600');
      expect(got.headers['authorization']).toContain(`k=${vapidKeys(PRIVATE).publicKey}`);
      expect(JSON.parse(decrypt(me, got.body))).toEqual({
        title: 'Your roster is published',
        body: 'Week of 19 Oct',
        link: '/roster/my',
        tag: 'roster_published',
      });
      const ok = await c.query<{ ok: boolean }>(
        'select last_ok_at is not null as ok from ops.push_subscription where id = $1',
        [sub.rows[0]!.id],
      );
      expect(ok.rows[0]!.ok).toBe(true);

      // the phone has gone (410): the next push archives it
      await c.query(
        `insert into ops.notification (tenant_id, owner_user_id, kind, title)
         select tenant_id, id, 'test', 'Again' from core.app_user where id = $1`,
        [steward],
      );
      answer = 410;
      await actAs(c, 'wf_executor', null);
      const again = await sendPushes(c, {
        privateHex: PRIVATE,
        subject: 'mailto:ops@example.com',
        rewrite: (e) => e.replace('https://fcm.googleapis.com', base),
      });
      await resetRole(c);
      expect(again).toEqual({ sent: 0, gone: 1, failed: 0 });
      const archived = await c.query(
        'select 1 from ops.push_subscription where id = $1 and archived_at is not null',
        [sub.rows[0]!.id],
      );
      expect(archived.rowCount).toBe(1);
    });
  });
});
