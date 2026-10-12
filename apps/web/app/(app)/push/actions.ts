'use server';

import { failure, type ActionResult } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { requireSameOrigin } from '@/lib/security/same-origin';

// This phone's alerts (ADR 137): the database saves or removes the signed-in person's own
// subscription and accepts only the browsers' push services.

export interface PhoneSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export async function turnOnAlerts(sub: PhoneSubscription, label: string): Promise<ActionResult> {
  try {
    await requireSameOrigin();
    const user = await requireUser();
    await withUser(user.id, (tx) =>
      sql`select ops.save_push_subscription(${sub.endpoint}, ${sub.p256dh}, ${sub.auth},
                                             ${label.slice(0, 80)})`.execute(tx),
    );
    return { ok: true, data: undefined };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error('save_push_subscription failed', err);
    return f;
  }
}

export async function turnOffAlerts(endpoint: string): Promise<ActionResult> {
  try {
    await requireSameOrigin();
    const user = await requireUser();
    await withUser(user.id, (tx) =>
      sql`select ops.remove_push_subscription(${endpoint})`.execute(tx),
    );
    return { ok: true, data: undefined };
  } catch (err) {
    return failure(err);
  }
}
