import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { sql, withUser } from '../db';
import {
  PLACE_COOKIE,
  PKCE_COOKIE,
  REFRESH_COOKIE,
  SESSION_COOKIE,
  issuedBeforeSignOut,
  sessionMaxAge,
  signSession,
  verifySession,
  type SessionPayload,
} from './session';
import { SHOW_AS_COOKIE, showAsClaim } from './show-as';

export function sessionSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is not set');
  return s;
}

const secure = process.env.NODE_ENV === 'production';

export async function setSessionCookie(payload: SessionPayload): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, await signSession(payload, sessionSecret()), {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: sessionMaxAge(payload),
  });
}

export async function clearAuthCookies(): Promise<void> {
  const jar = await cookies();
  for (const name of [SESSION_COOKIE, REFRESH_COOKIE, PLACE_COOKIE, PKCE_COOKIE, SHOW_AS_COOKIE]) {
    jar.delete(name);
  }
}

export interface CurrentUser {
  id: string;
  tenantId: string;
  kind: 'human' | 'service';
  name: string;
  source: SessionPayload['src'];
  /** a demo presenter showing the app as this person (ADR 071) */
  presentedBy: { id: string; name: string } | null;
  /** they may open "Show as" (a presenter, or showing as someone now) */
  canShowAs: boolean;
}

/**
 * The signed-in user, re-checked against core.me() (inactive users are signed out) and
 * against "sign out of all devices" (core.my_sessions_valid_from, ADR 018).
 */
export const currentUser = cache(async (): Promise<CurrentUser | null> => {
  const jar = await cookies();
  const v = await verifySession(jar.get(SESSION_COOKIE)?.value, sessionSecret());
  if (!v.ok) return null;
  const claim = await showAsClaim();
  const rows = await withUser(v.payload.uid, async (tx) => {
    const r = await sql<{
      id: string;
      tenant_id: string;
      kind: 'human' | 'service';
      display_name: string;
      valid_from: Date | null;
      presenter: boolean;
      showing: boolean;
    }>`
      select m.*, core.my_sessions_valid_from() as valid_from,
             core.am_presenter() as presenter,
             ${claim?.targetId ?? null}::uuid is not null
               and core.showing_as(${claim?.targetId ?? null}::uuid) as showing
        from core.me() m`.execute(tx);
    return r.rows;
  });
  const me = rows[0];
  if (!me || issuedBeforeSignOut(v.payload.iat, me.valid_from)) return null;
  const self: CurrentUser = {
    id: me.id,
    tenantId: me.tenant_id,
    kind: me.kind,
    name: me.display_name,
    source: v.payload.src,
    presentedBy: null,
    canShowAs: me.presenter,
  };
  if (!claim || !me.showing) return self;
  // shown as someone (ADR 071): every request runs as them from here on
  const shown = await withUser(claim.targetId, async (tx) => {
    const r = await sql<{
      id: string;
      tenant_id: string;
      kind: 'human' | 'service';
      display_name: string;
    }>`select * from core.me()`.execute(tx);
    return r.rows[0];
  });
  if (!shown) return self;
  return {
    id: shown.id,
    tenantId: shown.tenant_id,
    kind: shown.kind,
    name: shown.display_name,
    source: v.payload.src,
    presentedBy: { id: me.id, name: me.display_name },
    canShowAs: true,
  };
});

export async function requireUser(): Promise<CurrentUser> {
  const user = await currentUser();
  if (!user) redirect('/login?reason=expired');
  return user;
}
