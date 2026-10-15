import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// The auditor reads the access audit (ADR 153): AUDIT at the company's root opens
// core.access_audit for the whole company, read-only. It gives no way to manage people, and
// anyone without AUDIT or USER_ACCESS is still refused.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

describe('core.access_audit for the auditor', () => {
  it('the auditor reads the company access audit', async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs<{ action: string }>(
        c,
        ids.user('test.auditor'),
        'select action from core.access_audit(300)',
      );
      expect(r.error).toBeUndefined();
      // the loader granted every test person their access: the audit has those rows
      expect(r.rows!.map((x) => x.action)).toContain('granted');
    });
  });

  it('it reads all the account owner reads, and the supply side too', async () => {
    await inRolledBackTx(async (c) => {
      const q =
        'select occurred_at, action, person, access_group, place from core.access_audit(500)';
      const auditor = await attemptAs<Record<string, unknown>>(c, ids.user('test.auditor'), q);
      const owner = await attemptAs<Record<string, unknown>>(c, ids.user('test.account-owner'), q);
      expect(auditor.error).toBeUndefined();
      expect(owner.error).toBeUndefined();
      const seen = new Set(auditor.rows!.map((r) => JSON.stringify(r)));
      for (const r of owner.rows!) expect(seen.has(JSON.stringify(r))).toBe(true);
      // the whole company: grants on the supply side, outside any people admin's scope
      expect(auditor.rows!.some((r) => r.place === 'Test Supply Network')).toBe(true);
    });
  });

  it('the auditor still cannot manage people', async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs(c, ids.user('test.auditor'), 'select * from core.admin_users()');
      expect(r.error).toMatch(/NOT_AUTHORISED/);
    });
  });

  it('someone without AUDIT or USER_ACCESS is refused', async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs(
        c,
        ids.user('test.server.3.0'),
        'select * from core.access_audit(10)',
      );
      expect(r.error).toMatch(/NOT_AUTHORISED/);
    });
  });
});
