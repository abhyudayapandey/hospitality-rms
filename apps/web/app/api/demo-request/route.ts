import { demoRequestSchema, errorCodeOf } from '@outlet-ops/domain';
import { NextResponse } from 'next/server';
import { addDemoRequest } from '@/lib/db';
import { clientAddress, LIMITS, withinLimit } from '@/lib/security/rate-limit';
import { isSameOrigin } from '@/lib/security/same-origin';

// The website's "Get a Senior" form (ADR 141). Caddy sends heysenior.app/api/demo-request
// here, so the form posts to its own origin; this is the only way in with no session:
// - only from the website (Origin and Sec-Fetch-Site are SITE_URL's), never from the app or
//   anyone else;
// - at most LIMITS.demoRequest per address, and the database refuses a flood from everyone;
// - a filled trap field (bots fill every field) is thanked and dropped;
// - the database checks every field again.
export const dynamic = 'force-dynamic';

const reply = (status: number, body: object) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(req: Request): Promise<Response> {
  const siteUrl = process.env.SITE_URL;
  if (!siteUrl || !isSameOrigin(req.headers, siteUrl)) return reply(403, { code: 'CROSS_ORIGIN' });
  if (!(await withinLimit(`demo:${clientAddress(req.headers)}`, LIMITS.demoRequest))) {
    return reply(429, { code: 'RATE_LIMITED' });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return reply(400, { code: 'INVALID_DEMO_REQUEST' });
  }
  const parsed = demoRequestSchema.safeParse(body);
  if (!parsed.success) return reply(400, { code: 'INVALID_DEMO_REQUEST' });
  if (parsed.data.website !== '') return reply(200, { ok: true });
  try {
    await addDemoRequest(parsed.data);
  } catch (e) {
    const code = errorCodeOf(e);
    if (code === 'RATE_LIMITED') return reply(429, { code });
    if (code === 'INVALID_DEMO_REQUEST') return reply(400, { code });
    console.error('demo request', code);
    return reply(500, { code: 'UNEXPECTED' });
  }
  return reply(200, { ok: true });
}
