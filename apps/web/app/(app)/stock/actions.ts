'use server';

import { revalidatePath } from 'next/cache';
import { failure, type ActionResult } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser, type Tx } from '@/lib/db';
import {
  isPhotoType,
  MAX_PHOTO_BYTES,
  photosEnabled,
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
): Promise<ActionResult<{ id: string; approval: boolean }>> {
  return run('record_wastage', async (tx) => {
    const r = await sql<{ id: string }>`
      select inv.record_wastage(${node}::uuid, ${json(lines)}::jsonb, ${idempotencyKey}) as id`.execute(
      tx,
    );
    const id = r.rows[0]!.id;
    const a = await sql<{ adjustment_id: string | null }>`
      select adjustment_id from inv.wastage where id = ${id}::uuid`.execute(tx);
    return { id, approval: a.rows[0]?.adjustment_id != null };
  });
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
