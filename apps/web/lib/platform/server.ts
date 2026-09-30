import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { sessionSecret } from '../auth/server';
import { PLATFORM_COOKIE, verifyPlatformSession } from './session';

/** The signed-in platform admin's id (platform.admin); otherwise to the platform sign-in. */
export async function requirePlatformAdmin(): Promise<string> {
  const jar = await cookies();
  const v = await verifyPlatformSession(jar.get(PLATFORM_COOKIE)?.value, sessionSecret());
  if (!v.ok) redirect(`/platform/signin?reason=${v.reason}`);
  return v.payload.aid;
}
