import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { errorCodeOf } from '@outlet-ops/domain';
import { appUrl } from '@/lib/app-url';
import { withPlatformAdmin } from '@/lib/db';
import { requirePlatformAdmin } from '@/lib/platform/server';
import { requireSameOrigin } from '@/lib/security/same-origin';
import { loadDraft, saveDraft } from '../../draft';
import { applyForm, fieldsOf, isStep, stepAfter } from '../../form';

// Every wizard screen posts here (ADR 064): the form is applied to the draft, the draft is
// saved, and Back, Next or a step's own button decides where to go. Plain forms, so a slow
// phone or a lost connection never loses more than the screen being filled.
export async function POST(req: Request, ctx: { params: Promise<{ draft: string }> }) {
  try {
    await requireSameOrigin();
  } catch {
    return new NextResponse('refused', { status: 403 });
  }
  const admin = await requirePlatformAdmin();
  const { draft: id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new NextResponse('not found', { status: 404 });
  const f = fieldsOf(await req.formData());
  const step = f.get('step')?.[0] ?? '';
  if (!isStep(step)) return new NextResponse('bad request', { status: 400 });
  const go = f.get('go')?.[0] ?? 'stay';
  try {
    const url = await withPlatformAdmin(admin, async (tx) => {
      const found = await loadDraft(tx, id);
      if (!found) return null;
      if (found.row.apply_job) return appUrl(`/platform/setup/${id}/review`);
      const r = applyForm(found.draft, step, f, () => randomUUID().slice(0, 8));
      const next = stepAfter(step, go);
      await saveDraft(tx, id, r.draft, next);
      const url = appUrl(`/platform/setup/${id}/${next}`);
      for (const n of r.notes) url.searchParams.append('note', n);
      if (next === step && r.outlet) url.searchParams.set('saved', r.outlet);
      return url;
    });
    if (!url) return new NextResponse('not found', { status: 404 });
    return NextResponse.redirect(url, 303);
  } catch (err) {
    const code = errorCodeOf(err);
    if (code === 'UNEXPECTED') console.error('setup save failed', (err as Error).name);
    const url = appUrl(`/platform/setup/${id}/${step}`);
    url.searchParams.set('error', `Not saved (${code}). Try again.`);
    return NextResponse.redirect(url, 303);
  }
}
