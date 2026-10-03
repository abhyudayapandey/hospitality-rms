import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';
import { everyone } from '../test/report-access';

// Sending an order to the supplier (PO-4, ADR 032). The app opens WhatsApp, the mail app or a
// printable page on the person's phone; there is no server email. Each send is recorded on
// the order: by whom, when, by which channel. Only people who run the store's orders
// (PURCHASE_ORDERS modify there) send, and only a released order. They also keep the
// supplier's phone and email up to date; every change is audited.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

/** The Dairy & Poultry order from file 33: released, never delivered. */
async function dairyOrder(c: PoolClient): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `select po.id from inv.purchase_order po join inv.supplier s on s.id = po.supplier_id
      where po.tenant_id = $1 and s.name = 'Test Supplier – Dairy & Poultry'
        and po.status = 'released'`,
    [ids.tenant()],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

async function supplier(c: PoolClient, name: string, tenant = ids.tenant()): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    'select id from inv.supplier where tenant_id = $1 and name = $2',
    [tenant, name],
  );
  return rows[0]!.id;
}

const send = (c: PoolClient, user: string, po: string, channel: string) =>
  attemptAs(c, user, 'select inv.record_po_send($1, $2)', [po, channel]);

const setContact = (
  c: PoolClient,
  user: string,
  s: string,
  phone: string | null,
  email: string | null,
) => attemptAs(c, user, 'select inv.update_supplier_contact($1, $2, $3)', [s, phone, email]);

describe('recording a send', () => {
  it('only people who run the store’s orders send it (every user)', async () => {
    await inRolledBackTx(async (c) => {
      const po = await dairyOrder(c);
      const store = ids.node('TEST-HOTEL-1.0-KITCHEN-STORE');
      const wrong: string[] = [];
      let allowed = 0;
      for (const p of await everyone(c)) {
        await c.query(`select set_config('app.user_id', $1, true)`, [p.id]);
        const may = (
          await c.query<{ ok: boolean }>(
            `select core.my_tenant() = $2 and core.can('PURCHASE_ORDERS', 'modify', null, $1) as ok`,
            [store, ids.tenant()],
          )
        ).rows[0]!.ok;
        await c.query(`select set_config('app.user_id', '', true)`);
        const r = await send(c, p.id, po, 'whatsapp');
        if (may) allowed++;
        if (may !== (r.error === undefined)) {
          wrong.push(`${p.username}: may=${may}, got ${r.error ?? 'sent'}`);
        }
        if (!may && r.error !== 'NOT_AUTHORISED' && r.error !== 'NOT_FOUND') {
          wrong.push(`${p.username}: refused with ${r.error}`);
        }
      }
      expect(wrong).toEqual([]);
      // the executive chef (store keeper of the kitchen store) and the outlet's managers
      expect(allowed).toBeGreaterThan(1);
    });
  }, 180_000);

  it('records who, when and how; the order’s people see the sends; staff do not', async () => {
    await inRolledBackTx(async (c) => {
      const po = await dairyOrder(c);
      const chef = ids.user('test.executive-chef.1.0');
      expect((await send(c, chef, po, 'whatsapp')).error).toBeUndefined();
      expect((await send(c, chef, po, 'print')).error).toBeUndefined();
      const seen = await attemptAs<{ channel: string; sent_by: string }>(
        c,
        chef,
        'select channel, sent_by from inv.po_send where po_id = $1 order by sent_at, channel',
        [po],
      );
      expect(seen.rows).toEqual([
        { channel: 'print', sent_by: chef },
        { channel: 'whatsapp', sent_by: chef },
      ]);
      const named = await attemptAs<{ channel: string; sent_by_name: string }>(
        c,
        ids.user('test.general-manager.1.0'),
        'select channel, sent_by_name from inv.po_sends($1)',
        [po],
      );
      expect(named.rows?.map((r) => r.sent_by_name)).toEqual([
        'Test Executive Chef 1.0',
        'Test Executive Chef 1.0',
      ]);
      expect(
        (await attemptAs(c, ids.user('test.bartender.1.0'), 'select * from inv.po_sends($1)', [po]))
          .error,
      ).toBe('NOT_AUTHORISED');
      const bartender = await attemptAs(
        c,
        ids.user('test.bartender.1.0'),
        'select * from inv.po_send where po_id = $1',
        [po],
      );
      expect(bartender.rows ?? []).toEqual([]);
      const audit = await c.query<{ n: number }>(
        `select count(*)::int as n from audit.log
          where table_name = 'inv.po_send' and occurred_at >= now() and actor_id = $1`,
        [chef],
      );
      expect(audit.rows[0]!.n).toBe(2);
    });
  });

  it('refuses an order not yet released, an unknown channel, and a direct insert', async () => {
    await inRolledBackTx(async (c) => {
      const chef = ids.user('test.executive-chef.1.0');
      await c.query(`select set_config('app.user_id', $1, true)`, [chef]);
      const draft = (
        await c.query<{ id: string }>(
          `select inv.create_po($1, $2,
                                jsonb_build_array(jsonb_build_object(
                                  'item_id', (select id from inv.item where sku = 'TOMATOES'
                                                 and tenant_id = $3),
                                  'qty', 1, 'unit_cost', 40))) as id`,
          [
            ids.node('TEST-HOTEL-1.0-KITCHEN-STORE'),
            await supplier(c, 'Test Supplier – Fresh Produce'),
            ids.tenant(),
          ],
        )
      ).rows[0]!.id;
      await c.query(`select set_config('app.user_id', '', true)`);
      expect((await send(c, chef, draft, 'email')).error).toBe('INVALID_STATE');
      expect((await send(c, chef, await dairyOrder(c), 'fax')).error).toBe('INVALID_CHANNEL');
      const direct = await attemptAs(
        c,
        chef,
        `insert into inv.po_send (tenant_id, po_id, delivery_node_id, channel, sent_by)
         values ($1, $2, $3, 'email', $4)`,
        [ids.tenant(), await dairyOrder(c), ids.node('TEST-HOTEL-1.0-KITCHEN-STORE'), chef],
      );
      expect(direct.error).toBeDefined();
    });
  });
});

describe('the supplier’s contact', () => {
  it('people who run a store’s orders keep it up to date (every user); audited', async () => {
    await inRolledBackTx(async (c) => {
      const dairy = await supplier(c, 'Test Supplier – Dairy & Poultry');
      const wrong: string[] = [];
      for (const p of await everyone(c)) {
        await c.query(`select set_config('app.user_id', $1, true)`, [p.id]);
        const may = (
          await c.query<{ ok: boolean }>(
            `select core.my_tenant() = $1
                    and exists (select 1 from core.hierarchy_node n
                                 where n.tenant_id = $1 and n.type = 'delivery' and n.holds_stock
                                   and core.can('PURCHASE_ORDERS', 'modify', null, n.id)) as ok`,
            [ids.tenant()],
          )
        ).rows[0]!.ok;
        await c.query(`select set_config('app.user_id', '', true)`);
        const r = await setContact(c, p.id, dairy, '+91 98200 00001', 'orders@dairy.example');
        if (may !== (r.error === undefined)) {
          wrong.push(`${p.username}: may=${may}, got ${r.error ?? 'saved'}`);
        }
      }
      expect(wrong).toEqual([]);

      const chef = ids.user('test.executive-chef.1.0');
      expect((await setContact(c, chef, dairy, '+91 98200 12345', null)).error).toBeUndefined();
      const row = await c.query<{ phone: string; contact: string | null }>(
        'select phone, contact from inv.supplier where id = $1',
        [dairy],
      );
      expect(row.rows[0]).toEqual({ phone: '+91 98200 12345', contact: null });
      const audit = await c.query<{ n: number }>(
        `select count(*)::int as n from audit.log where table_name = 'inv.supplier'
          and row_id = $1 and occurred_at >= now() and actor_id = $2`,
        [dairy, chef],
      );
      expect(audit.rows[0]!.n).toBeGreaterThan(0);
    });
  });

  it('refuses a malformed phone or email, and another company’s supplier', async () => {
    await inRolledBackTx(async (c) => {
      const chef = ids.user('test.executive-chef.1.0');
      const dairy = await supplier(c, 'Test Supplier – Dairy & Poultry');
      for (const [phone, email] of [
        ['12', null],
        ['call me', null],
        ['+91 98200 00001 ext 4 and more digits 12345', null],
        [null, 'not an email'],
        [null, 'a@b'],
      ] as const) {
        expect((await setContact(c, chef, dairy, phone, email)).error, `${phone} ${email}`).toBe(
          'INVALID_CONTACT',
        );
      }
      const solo = await c.query<{ id: string }>(
        `select s.id from inv.supplier s join core.tenant t on t.id = s.tenant_id
          where t.code = 'TEST-SOLO-COMPANY' limit 1`,
      );
      expect((await setContact(c, chef, solo.rows[0]!.id, '+91 98200 00001', null)).error).toBe(
        'NOT_FOUND',
      );
    });
  });
});
