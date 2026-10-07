import 'server-only';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { SESSION_COOKIE, signToken, verifySession, verifyToken } from './session';

// Show as someone else, for demos (ADR 071). A demo presenter (a test customer's person
// marked in file 07) picks someone of their company; this cookie then says "requests from
// this session run as that person". It is signed and names both people, and only counts in
// the presenter's own session. The database decides the rest on every request:
// core.showing_as before the person is shown, core.presented_by in every transaction.

export const SHOW_AS_COOKIE = 'oo_show_as';

interface ShowAsPayload {
  v: 1;
  typ: 'show_as';
  /** the presenter, the signed-in person */
  p: string;
  /** the person shown */
  t: string;
}

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is not set');
  return s;
}

export function showAsToken(presenter: string, target: string): Promise<string> {
  const payload: ShowAsPayload = { v: 1, typ: 'show_as', p: presenter, t: target };
  return signToken(payload, secret());
}

export interface Presenting {
  presenterId: string;
  targetId: string;
}

/**
 * The cookie's claim for this request, if it is signed and its presenter is the signed-in
 * person: not yet checked against the database (currentUser does that once per request).
 */
export const showAsClaim = cache(async (): Promise<Presenting | null> => {
  let jar;
  try {
    jar = await cookies();
  } catch {
    return null; // outside a request
  }
  const raw = jar.get(SHOW_AS_COOKIE)?.value;
  if (!raw) return null;
  const session = await verifySession(jar.get(SESSION_COOKIE)?.value, secret());
  if (!session.ok) return null;
  const p = (await verifyToken(raw, secret())) as ShowAsPayload | null;
  if (!p || p.v !== 1 || p.typ !== 'show_as' || typeof p.t !== 'string') return null;
  if (p.p !== session.payload.uid) return null;
  return { presenterId: p.p, targetId: p.t };
});
