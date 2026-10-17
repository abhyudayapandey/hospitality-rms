import { describe, expect, it } from 'vitest';
import { appPoolConfig } from './index';

// The app's connection pool has limits (ADR 169): a slow report or a burst at shift start
// waits a bounded time for a connection and then fails in plain words, and no statement or
// open transaction can hold a connection for ever.

describe('appPoolConfig', () => {
  it('bounds the pool, the wait for a connection, statements and idle transactions', () => {
    const c = appPoolConfig('postgres://x', {});
    expect(c.max).toBe(15);
    expect(c.connectionTimeoutMillis).toBe(10_000);
    expect(c.idleTimeoutMillis).toBe(30_000);
    expect(c.options).toContain('-c jit=off');
    expect(c.options).toContain('-c statement_timeout=60000');
    expect(c.options).toContain('-c idle_in_transaction_session_timeout=60000');
    expect(c.options).toContain('-c lock_timeout=15000');
  });

  it('takes the pool size from DB_POOL_MAX when set', () => {
    expect(appPoolConfig('postgres://x', { DB_POOL_MAX: '25' }).max).toBe(25);
    expect(appPoolConfig('postgres://x', { DB_POOL_MAX: 'lots' }).max).toBe(15);
  });
});
