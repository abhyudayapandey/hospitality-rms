'use server';

import { revalidatePath } from 'next/cache';
import { failure, type ActionResult } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser, type Tx } from '@/lib/db';
import {
  isPhotoType,
  MAX_PHOTO_BYTES,
  photosEnabled,
  presignPhotoUpload,
  presignWastageUpload,
  type UploadTarget,
} from '@/lib/photos';
import { requireModule } from '@/lib/modules-server';

// Supply writes. Each calls one inv.* SECURITY DEFINER function, which checks core.can()
// on the node and changes stock only through ledger rows (CLAUDE.md rules 2 and 3). The
// idempotency key comes from the form, so a double tap or a retry on a slow network
// returns the first result instead of posting twice.

export interface Line {
  item_id: string;
  qty: number;
}

async function run<T>(label: string, fn: (tx: Tx) => Promise<T>): Promise<ActionResult<T>> {
  const user = await requireUser();
  try {
    const data = await withUser(user.id, fn);
    revalidatePath('/stock', 'layout');
    revalidatePath('/inbox');
    return { ok: true, data };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error(`${label} failed`, err);
    return f;
  }
}

const json = (v: unknown) => JSON.stringify(v);
const cleanLines = (lines: Line[]) =>
  lines.filter((l) => Number.isFinite(l.qty)).map((l) => ({ item_id: l.item_id, qty: l.qty }));

export async function startCount(node: string): Promise<ActionResult<{ id: string }>> {
  return run('start_count', async (tx) => {
    const r = await sql<{ id: string }>`select inv.start_count(${node}::uuid) as id`.execute(tx);
    return { id: r.rows[0]!.id };
  });
}

export interface CountSummary {
  posted: number;
  approval: number;
  no_change: number;
  adjustment_id: string | null;
}

export async function submitCount(
  countId: string,
  lines: { item_id: string; counted_qty: number }[],
): Promise<ActionResult<CountSummary>> {
  return run('submit_count', async (tx) => {
    const r = await sql<{ s: CountSummary }>`
      select inv.submit_count(${countId}::uuid, ${json(lines)}::jsonb) as s`.execute(tx);
    return r.rows[0]!.s;
  });
}

export interface WastageLine {
  item_id: string;
  qty: number;
  reason: string;
  photo_key?: string | null;
}

export async function recordWastage(
  node: string,
  lines: WastageLine[],
  idempotencyKey: string,
  /** when it happened, for an entry saved on the phone while offline (INV-8) */
  occurredAt?: string | null,
): Promise<ActionResult<{ id: string; approval: boolean }>> {
  return run('record_wastage', async (tx) => {
    const r = occurredAt
      ? await sql<{ id: string }>`
          select inv.record_wastage_at(${node}::uuid, ${json(lines)}::jsonb, ${idempotencyKey},
                                       ${occurredAt}::timestamptz) as id`.execute(tx)
      : await sql<{ id: string }>`
          select inv.record_wastage(${node}::uuid, ${json(lines)}::jsonb, ${idempotencyKey}) as id`.execute(
          tx,
        );
    const id = r.rows[0]!.id;
    const a = await sql<{ adjustment_id: string | null }>`
      select adjustment_id from inv.wastage where id = ${id}::uuid`.execute(tx);
    return { id, approval: a.rows[0]?.adjustment_id != null };
  });
}

export interface UnusualCheck {
  /** the department head (or the GM) will have to approve */
  needs: boolean;
  /** in plain words: "Prawns: not on the menu", "Oil: 16 kg, usual 10 kg a week" */
  why: string[];
}

/**
 * Before sending an order or a request for material: will it need the department head's
 * approval (PO-5, TR-3, ADR 043)? Asks inv.unusual_lines, which applies the same rule the
 * workflow does. A transfer only needs approval when it goes to a department's store.
 */
export async function checkUnusual(
  node: string,
  lines: Line[],
  kind: 'order' | 'transfer',
): Promise<ActionResult<UnusualCheck>> {
  const user = await requireUser();
  try {
    const data = await withUser(user.id, async (tx) => {
      if (kind === 'transfer') {
        const d = await sql<{ rfm: boolean }>`
          select exists (select 1 from core.node_link nl
                           join core.hierarchy_node o on o.id = nl.org_node_id
                                                     and o.kind = 'department'
                          where nl.delivery_node_id = ${node}::uuid) as rfm`.execute(tx);
        if (!d.rows[0]?.rfm) return { needs: false, why: [] };
      }
      const r = await sql<{
        name: string;
        reason: string;
        qty: string;
        weekly_avg: string;
        uom: string;
      }>`
        select i.name, u.reason, u.qty, u.weekly_avg, i.base_uom as uom
          from inv.unusual_lines(${node}::uuid, ${json(cleanLines(lines))}::jsonb) u
          join inv.item i on i.id = u.item_id order by i.name`.execute(tx);
      return {
        needs: r.rows.length > 0,
        why: r.rows.map((x) =>
          x.reason === 'off_menu'
            ? `${x.name}: not on the menu`
            : `${x.name}: ${Number(x.qty)} ${x.uom}, usual ${Number(x.weekly_avg)} ${x.uom} a week`,
        ),
      };
    });
    return { ok: true, data };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error('check_unusual failed', err);
    return f;
  }
}

export async function createPo(
  node: string,
  supplier: string,
  lines: { item_id: string; qty: number; unit_cost: number }[],
  notes: string,
  idempotencyKey: string,
): Promise<ActionResult<{ id: string }>> {
  return run('create_po', async (tx) => {
    const r = await sql<{ id: string }>`
      select inv.create_po(${node}::uuid, ${supplier}::uuid, ${json(lines)}::jsonb,
                           ${notes || null}, ${idempotencyKey}) as id`.execute(tx);
    return { id: r.rows[0]!.id };
  });
}

export async function receivePo(
  po: string,
  lines: Line[],
  idempotencyKey: string,
): Promise<ActionResult<{ id: string }>> {
  return run('receive', async (tx) => {
    const r = await sql<{ id: string }>`
      select inv.receive(${po}::uuid, ${json(cleanLines(lines))}::jsonb, ${idempotencyKey}) as id`.execute(
      tx,
    );
    return { id: r.rows[0]!.id };
  });
}

export async function requestTransfer(
  from: string,
  to: string,
  lines: Line[],
  idempotencyKey: string,
): Promise<ActionResult<{ id: string }>> {
  return run('request_transfer', async (tx) => {
    const r = await sql<{ id: string }>`
      select inv.request_transfer(${from}::uuid, ${to}::uuid, ${json(cleanLines(lines))}::jsonb,
                                  ${idempotencyKey}) as id`.execute(tx);
    return { id: r.rows[0]!.id };
  });
}

export async function dispatchTransfer(
  transfer: string,
  lines: Line[],
): Promise<ActionResult<{ state: string }>> {
  return run('dispatch_transfer', async (tx) => {
    const r = await sql<{ state: string }>`
      select inv.dispatch_transfer(${transfer}::uuid, ${json(cleanLines(lines))}::jsonb) as state`.execute(
      tx,
    );
    return { state: r.rows[0]!.state };
  });
}

export async function receiveTransfer(
  transfer: string,
  lines: Line[],
): Promise<ActionResult<{ state: string }>> {
  return run('receive_transfer', async (tx) => {
    const r = await sql<{ state: string }>`
      select inv.receive_transfer(${transfer}::uuid, ${json(cleanLines(lines))}::jsonb) as state`.execute(
      tx,
    );
    return { state: r.rows[0]!.state };
  });
}

/**
 * A presigned POST for one wastage photo at `node`. Access is decided in SQL:
 * core.can(STOCK_ADJUSTMENTS, modify) at the node (rule 2); the key embeds the tenant
 * and node, and record_wastage accepts only keys under that prefix.
 */
export async function getWastageUploadUrl(
  node: string,
  contentType: string,
  size: number,
): Promise<ActionResult<UploadTarget>> {
  if (!photosEnabled()) return { ok: false, code: 'INVALID_PHOTO', message: 'Photos are off.' };
  if (!isPhotoType(contentType) || size < 1 || size > MAX_PHOTO_BYTES) {
    return failure(new Error('INVALID_PHOTO'));
  }
  const user = await requireUser();
  try {
    const tenant = await withUser(user.id, async (tx) => {
      const r = await sql<{ ok: boolean; tenant: string | null }>`
        select core.can('STOCK_ADJUSTMENTS', 'modify', null, ${node}::uuid) as ok,
               core.my_tenant() as tenant`.execute(tx);
      if (!r.rows[0]?.ok || !r.rows[0].tenant) throw new Error('NOT_AUTHORISED');
      return r.rows[0].tenant;
    });
    return { ok: true, data: await presignWastageUpload(tenant, node, contentType) };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error('presign upload failed', err);
    return f;
  }
}

export interface ProductionLine {
  ingredient_item_id: string;
  qty: number;
}

/** A batch of a prep item made at the node (ADR 015); actual lines in recipe units. */
export async function recordProduction(
  node: string,
  prepItem: string,
  qtyMade: number,
  actual: ProductionLine[],
  idempotencyKey: string,
): Promise<ActionResult<{ id: string }>> {
  return run('record_production', async (tx) => {
    await requireModule(tx, 'production');
    const r = await sql<{ id: string }>`
      select inv.record_production(${node}::uuid, ${prepItem}::uuid, ${qtyMade}::numeric,
                                   ${json(actual)}::jsonb, ${idempotencyKey}) as id`.execute(tx);
    return { id: r.rows[0]!.id };
  });
}

// ---------------------------------------------------------------------------
// Sending an order to the supplier (PO-4, ADR 032). inv.record_po_send checks PURCHASE_ORDERS
// modify at the order's store and that the order is released; the page then opens WhatsApp,
// the mail app or the printable order on the person's phone.

export async function recordPoSend(
  po: string,
  channel: 'whatsapp' | 'email' | 'print',
): Promise<ActionResult<{ id: string }>> {
  return run('record_po_send', async (tx) => {
    const r = await sql<{ id: string }>`
      select inv.record_po_send(${po}::uuid, ${channel}) as id`.execute(tx);
    return { id: r.rows[0]!.id };
  });
}

/** The supplier's phone (for WhatsApp) and email; blank clears it. Audited. */
export async function updateSupplierContact(
  supplier: string,
  phone: string,
  email: string,
): Promise<ActionResult<null>> {
  return run('update_supplier_contact', async (tx) => {
    await sql`select inv.update_supplier_contact(${supplier}::uuid, ${phone || null},
                                                 ${email || null})`.execute(tx);
    return null;
  });
}

// --- item photos (UX-6, ADR 034) -------------------------------------------------------

/**
 * One presigned POST for an item's photo, after inv.can_set_item_photo() says the caller
 * may set it (rule 2). The key is items/<tenant>/<item>/<uuid>, the only shape
 * inv.set_item_photo accepts.
 */
export async function getItemUploadUrl(
  item: string,
  contentType: string,
  size: number,
): Promise<ActionResult<UploadTarget>> {
  if (!photosEnabled()) return { ok: false, code: 'INVALID_PHOTO', message: 'Photos are off.' };
  if (!isPhotoType(contentType) || size < 1 || size > MAX_PHOTO_BYTES) {
    return failure(new Error('INVALID_PHOTO'));
  }
  const user = await requireUser();
  try {
    const tenant = await withUser(user.id, async (tx) => {
      const r = await sql<{ ok: boolean; tenant: string | null }>`
        select inv.can_set_item_photo(${item}::uuid) as ok, core.my_tenant() as tenant`.execute(tx);
      if (!r.rows[0]?.ok || !r.rows[0].tenant) throw new Error('NOT_AUTHORISED');
      return r.rows[0].tenant;
    });
    return { ok: true, data: await presignPhotoUpload('items', tenant, item, contentType) };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error('item photo presign failed', err);
    return f;
  }
}

/** Sets (or with null clears) the item's photo; inv.set_item_photo checks who and the key. */
export async function setItemPhoto(
  item: string,
  photoKey: string | null,
): Promise<ActionResult<null>> {
  return run('set_item_photo', async (tx) => {
    await sql`select inv.set_item_photo(${item}::uuid, ${photoKey})`.execute(tx);
    return null;
  });
}
