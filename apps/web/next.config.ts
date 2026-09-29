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

  return {
    reactStrictMode: true,
    transpilePackages: ['@outlet-ops/db', '@outlet-ops/domain'],
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
