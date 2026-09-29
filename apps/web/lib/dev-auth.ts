// Dev-only login and the test request form (ADR 004). Next inlines process.env.NODE_ENV
// at build time, so a production build can never enable this, whatever DEV_AUTH_STUB
// says at runtime. next.config.ts also refuses to build for production with it set.

export function isDevAuthEnabled(
  env: { NODE_ENV?: string | undefined; DEV_AUTH_STUB?: string | undefined } = {
    NODE_ENV: process.env.NODE_ENV,
    DEV_AUTH_STUB: process.env.DEV_AUTH_STUB,
  },
): boolean {
  return env.NODE_ENV !== 'production' && env.DEV_AUTH_STUB === 'true';
}
