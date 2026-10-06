import { NextResponse } from 'next/server';

// The build this server runs (ADR 055); the app compares it with the build its page came from.
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json(
    { build: process.env.NEXT_PUBLIC_BUILD_ID ?? '' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
