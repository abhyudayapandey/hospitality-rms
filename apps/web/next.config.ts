import { join } from 'node:path';
import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from 'next/constants';

export default function config(phase: string): NextConfig {
  if (phase === PHASE_DEVELOPMENT_SERVER) {
    // Local dev reads the repo-root .env (DATABASE_URL, SESSION_SECRET, DEV_AUTH_STUB...).
    try {
      process.loadEnvFile(join(import.meta.dirname, '..', '..', '.env'));
    } catch {
      // no .env file; rely on the environment
    }
  }
  if (phase === PHASE_PRODUCTION_BUILD && process.env.DEV_AUTH_STUB === 'true') {
    // Dev login is compiled out of production builds anyway (ADR 004); refuse the
    // confusing configuration outright.
    throw new Error('DEV_AUTH_STUB=true is not allowed in a production build');
  }

  // one id per build, in the server and in the page's code: a page from an older build sees
  // the server's differ and offers a reload (ADR 055). CI passes the commit.
  const buildId = process.env.GIT_SHA || process.env.GITHUB_SHA || String(Date.now());

  return {
    reactStrictMode: true,
    env: { NEXT_PUBLIC_BUILD_ID: buildId },
    // Self-contained server for the EC2 instance (ADR 005); built in CI only.
    output: 'standalone',
    outputFileTracingRoot: join(import.meta.dirname, '..', '..'),
    transpilePackages: ['@outlet-ops/db', '@outlet-ops/domain', '@outlet-ops/onboarding'],
    serverExternalPackages: ['pg'],
    headers() {
      return Promise.resolve([
        {
          source: '/(.*)',
          headers: [
            { key: 'X-Content-Type-Options', value: 'nosniff' },
            { key: 'X-Frame-Options', value: 'DENY' },
            { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          ],
        },
        {
          source: '/sw.js',
          headers: [
            { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
            { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
            { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self'" },
          ],
        },
      ]);
    },
  };
}
