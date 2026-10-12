import 'server-only';
import { createECDH } from 'node:crypto';

/**
 * The VAPID public key a phone subscribes with (ADR 137): VAPID_PUBLIC_KEY on the instance
 * (fetch-params.sh works it out; the web never holds the private key), else, in dev, worked
 * out from VAPID_PRIVATE_KEY. Null: no push here, so the app offers no alerts.
 */
export function pushPublicKey(): string | null {
  const pub = process.env.VAPID_PUBLIC_KEY?.trim();
  if (pub) return pub;
  const hex = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) return null;
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(hex, 'hex'));
  return ecdh.getPublicKey().toString('base64url');
}
