import { NextResponse } from 'next/server';
import { errorCodeOf } from '@outlet-ops/domain';
import { currentUser } from '@/lib/auth/server';
import { toCsv, csvName, type Cell } from '@/lib/csv';
import { withUser, type Tx } from '@/lib/db';
import {
  costItems,
  kitchenDispatch,
  league,
  peopleDepartments,
  priceChanges,
  reportToday,
  stockItems,
  supplierFill,
} from '@/lib/report-data';
import { capRange, periodRange } from '@/lib/reports';

// CSV downloads of the reports (R-4, ADR 031). Each reads through the same rpt.* function as
// its screen, as the signed-in person, so it holds exactly what the screen shows; a place
// the person may not open is refused there (NOT_AUTHORISED) and answers 403.

type Export = (
  tx: Tx,
  node: string,
  from: string,
  to: string,
) => Promise<{ header: string[]; rows: Cell[][] }>;

const EXPORTS: Record<string, { days: number; run: Export }> = {
  league: {
    days: 35,
    run: async (tx, node, from, to) => ({
      header: [
        'outlet',
        'sales',
        'food_cost_pct',
        'drinks_cost_pct',
        'people_cost_pct',
        'prime_cost_pct',
        'wastage_pct',
        'tasks_on_time_pct',
      ],
      rows: (await league(tx, node, from, to)).map((r) => [
        r.name,
        r.sales,
        r.food_pct,
        r.drink_pct,
        r.labour_pct,
        r.prime_pct,
        r.wastage_pct,
        r.tasks_pct,
      ]),
    }),
  },
  cost_items: {
    days: 93,
    run: async (tx, node, from, to) => ({
      header: [
        'store',
        'sku',
        'item',
        'unit',
        'opening',
        'in',
        'out',
        'used',
        'expected',
        'variance_qty',
        'variance_value',
        'counted',
      ],
      rows: (await costItems(tx, node, from, to)).map((r) => [
        r.store_name,
        r.sku,
        r.name,
        r.unit,
        r.opening,
        r.came_in,
        r.went_out,
        r.used,
        r.expected_closing,
        r.variance_qty,
        r.variance_value,
        r.counted ? 'yes' : 'no',
      ]),
    }),
  },
  stock_items: {
    days: 1,
    run: async (tx, node) => ({
      header: [
        'sku',
        'item',
        'category',
        'unit',
        'on_hand',
        'value',
        'days_on_hand',
        'last_moved_at',
        'not_moved_30_days',
      ],
      rows: (await stockItems(tx, node)).map((r) => [
        r.sku,
        r.name,
        r.category,
        r.unit,
        r.on_hand,
        r.value,
        r.days_on_hand,
        r.last_moved_at,
        r.dead ? 'yes' : 'no',
      ]),
    }),
  },
  price_changes: {
    days: 93,
    run: async (tx, node, from, to) => ({
      header: [
        'received_at',
        'supplier',
        'sku',
        'item',
        'unit',
        'qty',
        'unit_cost',
        'previous_cost',
        'compared_with',
        'change_value',
      ],
      rows: (await priceChanges(tx, node, from, to)).map((r) => [
        r.received_at,
        r.supplier,
        r.sku,
        r.name,
        r.unit,
        r.qty,
        r.unit_cost,
        r.previous_cost,
        r.basis,
        r.change_value,
      ]),
    }),
  },
  supplier_fill: {
    days: 93,
    run: async (tx, node, from, to) => ({
      header: [
        'supplier',
        'orders',
        'ordered_value',
        'received_value',
        'fill_pct',
        'on_time',
        'late',
        'not_delivered',
        'not_due',
      ],
      rows: (await supplierFill(tx, node, from, to)).map((r) => [
        r.supplier,
        r.orders,
        r.ordered_value,
        r.received_value,
        r.fill_pct,
        r.on_time,
        r.late,
        r.not_delivered,
        r.not_due,
      ]),
    }),
  },
  people_departments: {
    days: 93,
    run: async (tx, node, from, to) => ({
      header: [
        'department',
        'headcount',
        'shifts',
        'late',
        'no_shows',
        'on_time_pct',
        'hours',
        'overtime_hours',
        'leave_days',
      ],
      rows: (await peopleDepartments(tx, node, from, to)).map((r) => [
        r.name,
        r.headcount,
        r.shifts,
        r.late,
        r.no_shows,
        r.on_time_pct,
        r.hours,
        r.overtime_hours,
        r.leave_days,
      ]),
    }),
  },
  kitchen_dispatch: {
    days: 93,
    run: async (tx, node, from, to) => ({
      header: [
        'store',
        'transfers',
        'requested_value',
        'dispatched_value',
        'received_value',
        'fill_pct',
        'transit_loss',
        'short_lines',
      ],
      rows: (await kitchenDispatch(tx, node, from, to)).map((r) => [
        r.store_name,
        r.transfers,
        r.requested_value,
        r.dispatched_value,
        r.received_value,
        r.fill_pct,
        r.transit_loss,
        r.short_lines,
      ]),
    }),
  },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function GET(req: Request, ctx: { params: Promise<{ report: string }> }) {
  const { report } = await ctx.params;
  const ex = EXPORTS[report];
  if (!ex) return new NextResponse('not found', { status: 404 });
  const user = await currentUser();
  if (!user) return new NextResponse('signed out', { status: 401 });
  const q = new URL(req.url).searchParams;
  const node = q.get('node') ?? '';
  if (!UUID.test(node)) return new NextResponse('not found', { status: 404 });
  try {
    const { csv, from, to } = await withUser(user.id, async (tx) => {
      const today = await reportToday(tx, node);
      const asked = periodRange(
        q.get('period') ?? undefined,
        today,
        q.get('from') ?? undefined,
        q.get('to') ?? undefined,
      );
      const { from, to } = capRange(asked.from, asked.to, ex.days);
      const { header, rows } = await ex.run(tx, node, from, to);
      return { csv: toCsv(header, rows), from, to };
    });
    // a byte-order mark, so Excel reads ₹ and names as UTF-8
    return new NextResponse(`\uFEFF${csv}`, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${csvName(report, from, to)}"`,
        'cache-control': 'private, no-store',
      },
    });
  } catch (err) {
    const code = errorCodeOf(err);
    if (code === 'NOT_AUTHORISED' || code === 'MODULE_OFF') {
      return new NextResponse('refused', { status: 403 });
    }
    if (code === 'INVALID_DATE') return new NextResponse('bad dates', { status: 400 });
    console.error('csv export failed', report, (err as Error).name);
    return new NextResponse('error', { status: 500 });
  }
}
