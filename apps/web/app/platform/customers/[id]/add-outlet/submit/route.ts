import { NextResponse } from 'next/server';
import { errorCodeOf } from '@outlet-ops/domain';
import { TemplateError, addOutlet, parseCsv } from '@outlet-ops/onboarding/templates';
import { appUrl } from '@/lib/app-url';
import { withPlatformAdmin } from '@/lib/db';
import { requestDryRun } from '@/lib/platform/import-files';
import { currentFiles } from '@/lib/platform/outlet-files';
import { requirePlatformAdmin } from '@/lib/platform/server';
import { requireSameOrigin } from '@/lib/security/same-origin';
import { choiceFrom, type Search } from '../choice';

// "Add and dry run" (ADR 062): the customer's current files with the outlet added are stored
// like an upload and go through the same dry run, report and apply as any import (ADR 013).

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireSameOrigin();
  } catch {
    return new NextResponse('refused', { status: 403 });
  }
  const admin = await requirePlatformAdmin();
  const { id: tenantId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(tenantId)) return new NextResponse('not found', { status: 404 });

  const form = await req.formData();
  const q: Search = {};
  for (const [k, v] of form.entries()) {
    if (typeof v !== 'string') continue;
    const had = q[k];
    q[k] = had === undefined ? v : [had, v].flat();
  }
  const again = (message: string) => {
    const url = appUrl(`/platform/customers/${tenantId}/add-outlet`);
    for (const [k, v] of Object.entries(q))
      for (const x of [v ?? ''].flat()) url.searchParams.append(k, x);
    url.searchParams.set('error', message);
    return NextResponse.redirect(url, 303);
  };

  try {
    const files = await withPlatformAdmin(admin, (tx) => currentFiles(tx, tenantId));
    if (!files) return again("This customer's setup files aren't known yet: import them first.");
    const customerFile = Object.keys(files).find((f) => f.startsWith('00_'))!;
    const customer = parseCsv(files[customerFile]!).rows[0]!.values;
    const timezone = customer['default_timezone'] || 'Asia/Kolkata';
    const merged = addOutlet(files, choiceFrom(q, timezone)).files;

    const job = await withPlatformAdmin(admin, (tx) =>
      requestDryRun(
        tx,
        tenantId,
        customer['customer_code']!,
        `Add outlet ${String(q.code ?? '').toUpperCase()}`,
        merged,
      ),
    );
    return NextResponse.redirect(appUrl(`/platform/jobs/${job}`), 303);
  } catch (err) {
    if (err instanceof TemplateError) return again(err.message);
    const code = errorCodeOf(err);
    if (code === 'UNEXPECTED') console.error('add outlet failed', (err as Error).name);
    return again(`Something went wrong (${code}). Try again.`);
  }
}
