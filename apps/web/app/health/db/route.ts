import { NextResponse } from 'next/server';
import { healthCheck } from '@/lib/db';

// The deploy's check (ADR 171): 200 when this build serves and the database answers as app_rw.
// Late jobs do not count here, so a deploy that fixes a broken job is never rolled back for it.
export const dynamic = 'force-dynamic';

export async function GET() {
  const { ok } = await healthCheck(false);
  return new NextResponse(ok ? 'ok' : 'not ok', {
    status: ok ? 200 : 503,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' },
  });
}
