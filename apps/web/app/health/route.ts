import { NextResponse } from 'next/server';
import { healthCheck } from '@/lib/db';

// The outside check (ADR 170): 200 only when the database answers and every server job ran in
// time. It says nothing else; the platform console lists which job is late.
export const dynamic = 'force-dynamic';

export async function GET() {
  const { ok } = await healthCheck(true);
  return new NextResponse(ok ? 'ok' : 'not ok', {
    status: ok ? 200 : 503,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' },
  });
}
