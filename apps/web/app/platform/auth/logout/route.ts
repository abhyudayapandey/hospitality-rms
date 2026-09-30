import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { logoutUrl } from '@/lib/auth/cognito';
import { PLATFORM_COOKIE, platformCognitoConfig } from '@/lib/platform/session';
import { requireSameOrigin } from '@/lib/security/same-origin';

// Ends the platform session here and at the platform pool's hosted UI.
export async function POST(req: Request) {
  try {
    await requireSameOrigin();
  } catch {
    return new NextResponse('refused', { status: 403 });
  }
  const jar = await cookies();
  jar.delete({ name: PLATFORM_COOKIE, path: '/platform' });
  const cfg = platformCognitoConfig();
  return NextResponse.redirect(
    cfg ? logoutUrl(cfg) : new URL('/platform/signed-out', req.url),
    303,
  );
}
