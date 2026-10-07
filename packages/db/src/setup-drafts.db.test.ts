import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asPlatform,
  attemptAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  newPlatformAdmin,
  type SeedIds,
} from '../test/helpers';

// Set-up drafts (ADR 064), written before the screens: only a platform admin reads or writes
// them, never a customer's user; a draft keeps its choices across saves and is in the
// platform audit; once a set-up is live its choices can't change; a thrown-away draft is gone
// from the list but kept.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const SAVE = 'select platform.save_setup_draft($1, $2, $3, $4) as id';

describe('set-up drafts', () => {
  it('a platform admin saves, resumes and throws away a draft; each step is audited', async () => {
    await inRolledBackTx(async (c) => {
      const admin = await newPlatformAdmin(c);
      const made = await asPlatform<{ id: string }>(c, admin, SAVE, [
        null,
        'Blue Bean Cafés',
        { company: { name: 'Blue Bean Cafés' } },
        'company',
      ]);
      const id = made.rows![0]!.id;
      await asPlatform(c, admin, SAVE, [
        id,
        'Blue Bean',
        { company: { name: 'Blue Bean' } },
        'outlets',
      ]);
      const got = await asPlatform<{ name: string; step: string; choices: unknown }>(
        c,
        admin,
        'select name, step, choices from platform.setup_draft($1)',
        [id],
      );
      expect(got.rows).toEqual([
        { name: 'Blue Bean', step: 'outlets', choices: { company: { name: 'Blue Bean' } } },
      ]);
      const list = await asPlatform<{ id: string; live: boolean }>(
        c,
        admin,
        'select id, live from platform.setup_drafts()',
      );
      expect(list.rows).toContainEqual({ id, live: false });
      await asPlatform(c, admin, 'select platform.archive_setup_draft($1)', [id]);
      const after = await asPlatform<{ id: string }>(
        c,
        admin,
        'select id from platform.setup_drafts()',
      );
      expect(after.rows!.map((r) => r.id)).not.toContain(id);
      expect((await asPlatform(c, admin, SAVE, [id, 'x', {}, 'company'])).error).toMatch(
        /INVALID_STATE/,
      );
      const { rows: audit } = await c.query<{ action: string }>(
        `select action from platform.audit_event where detail ->> 'draft' = $1 order by at`,
        [id],
      );
      expect(audit.map((a) => a.action)).toEqual(['setup_draft_started', 'setup_draft_archived']);
    });
  });

  it("a customer's user, or nobody, can't read or write drafts", async () => {
    await inRolledBackTx(async (c) => {
      const owner = ids.user('test.account-owner');
      expect((await attemptAs(c, owner, SAVE, [null, 'x', {}, 'company'])).error).toMatch(
        /NOT_AUTHORISED/,
      );
      expect((await attemptAs(c, owner, 'select * from platform.setup_drafts()')).error).toMatch(
        /NOT_AUTHORISED/,
      );
      expect((await attemptAs(c, owner, 'select * from platform.setup_draft')).error).toMatch(
        /permission denied/,
      );
    });
  });

  it('a draft records only jobs of the right kind, in order', async () => {
    await inRolledBackTx(async (c) => {
      const admin = await newPlatformAdmin(c);
      const id = (await asPlatform<{ id: string }>(c, admin, SAVE, [null, 'Acme', {}, 'review']))
        .rows![0]!.id;
      const job = (
        await c.query<{ id: string }>(
          `insert into platform.job (kind, tenant_id, payload) values ('import_dry_run', $1, '{}')
           returning id`,
          [ids.tenant('TEST-COMPANY')],
        )
      ).rows[0]!.id;
      expect(
        (
          await asPlatform(c, admin, 'select platform.set_setup_job($1, $2, $3)', [
            id,
            'create',
            job,
          ])
        ).error,
      ).toMatch(/INVALID_SETUP/);
      expect(
        (
          await asPlatform(c, admin, 'select platform.set_setup_job($1, $2, $3)', [
            id,
            'dry_run',
            job,
          ])
        ).error,
      ).toBeUndefined();
      const d = await asPlatform<{ tenant_id: string; dry_run_job: string }>(
        c,
        admin,
        'select tenant_id, dry_run_job from platform.setup_draft($1)',
        [id],
      );
      expect(d.rows).toEqual([{ tenant_id: ids.tenant('TEST-COMPANY'), dry_run_job: job }]);
    });
  });
});
