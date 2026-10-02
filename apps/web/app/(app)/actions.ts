'use server';

import { cookies } from 'next/headers';
import { requireUser } from '@/lib/auth/server';
import { PLACE_COOKIE } from '@/lib/auth/session';
import { sql, withUser } from '@/lib/db';
import { isScreen, withChoice } from '@/lib/place-screens';
import { rememberedPlaces } from '@/lib/places';

/**
 * Remembers the place chosen on a screen's "Place:" switcher (ADR 016). Only a place
 * core.screen_places() offers on that screen is kept. The page itself follows ?node=.
 */
export async function rememberPlace(
  screen: string,
  placeId: string,
  _idempotencyKey?: string,
): Promise<void> {
  if (!isScreen(screen)) return;
  const user = await requireUser();
  const ok = await withUser(user.id, async (tx) => {
    const r = await sql<{ id: string }>`
      select id from core.screen_places(${screen}) where id::text = ${placeId}`.execute(tx);
    return r.rows.length === 1;
  });
  if (!ok) return;
  (await cookies()).set(PLACE_COOKIE, withChoice(await rememberedPlaces(), screen, placeId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 90 * 24 * 60 * 60,
  });
}
