'use server';

import { revalidatePath } from 'next/cache';
import { failure, type ActionResult } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';

// An outlet's or site's location and clock-in radius (ADR 018). hr.set_place_location
// checks who may (ATTENDANCE modify at the place, or COMPANY_SETTINGS modify) and the
// values; the audit trigger records the change. The next clock-in uses it. Setting the
// same values again changes nothing, so the action is safe to repeat.
export async function setPlaceLocation(input: {
  node: string;
  lat: number;
  lng: number;
  radius: number;
}): Promise<ActionResult> {
  const user = await requireUser();
  try {
    await withUser(user.id, (tx) =>
      sql`select hr.set_place_location(${input.node}::uuid, ${input.lat}::numeric,
                                        ${input.lng}::numeric, ${input.radius}::int)`.execute(tx),
    );
    revalidatePath('/settings/location');
    return { ok: true, data: undefined };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error('set_place_location failed', err);
    return f;
  }
}
