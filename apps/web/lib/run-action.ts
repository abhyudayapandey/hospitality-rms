import 'server-only';
import { revalidatePath } from 'next/cache';
import { failure, type ActionResult, type ModuleCode } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { withUser, type Tx } from '@/lib/db';
import { requireModule } from '@/lib/modules-server';

/** A path to refresh after a change, and whether its whole layout goes with it. */
export type Revalidate = string | [path: string, type: 'layout' | 'page'];

/**
 * The body of a server action (ADR 169): as the signed-in person (a missing session
 * redirects to sign-in, outside the try so the redirect reaches Next), with the module
 * switched on when it has one, then the screens it changes are refreshed. A refusal from the
 * database comes back as its code and plain words; anything else is logged by `label`
 * and shown as Something went wrong.
 */
export async function runAction<T>(
  label: string,
  fn: (tx: Tx) => Promise<T>,
  opts: { module?: ModuleCode; revalidate?: readonly Revalidate[] } = {},
): Promise<ActionResult<T>> {
  const user = await requireUser();
  try {
    const data = await withUser(user.id, async (tx) => {
      if (opts.module) await requireModule(tx, opts.module);
      return fn(tx);
    });
    for (const r of opts.revalidate ?? []) {
      if (typeof r === 'string') revalidatePath(r);
      else revalidatePath(r[0], r[1]);
    }
    return { ok: true, data };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error(`${label} failed`, err);
    return f;
  }
}
