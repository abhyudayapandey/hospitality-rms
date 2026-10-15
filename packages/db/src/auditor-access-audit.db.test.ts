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

  it('it reads no more than the account owner, who reads the whole company', async () => {
    await inRolledBackTx(async (c) => {
      const q = 'select count(*)::int as n from core.access_audit(500)';
      const auditor = await attemptAs<{ n: number }>(c, ids.user('test.auditor'), q);
      const owner = await attemptAs<{ n: number }>(c, ids.user('test.account-owner'), q);
      expect(auditor.error).toBeUndefined();
      expect(owner.error).toBeUndefined();
      expect(auditor.rows![0]!.n).toBe(owner.rows![0]!.n);
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
