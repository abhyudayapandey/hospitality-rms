import { NextResponse } from 'next/server';
import { errorCodeOf } from '@outlet-ops/domain';
import { currentUser } from '@/lib/auth/server';
import { csvName, toCsv } from '@/lib/csv';
import { withUser } from '@/lib/db';
import { EXPORTS } from '@/lib/exports';

// A list as a CSV file (ADR 120): the rows its screen shows for the same days, read as the
// signed-in person (lib/exports.ts). Unknown list or place: 404; not theirs to see: 403.
export async function GET(req: Request, ctx: { params: Promise<{ list: string }> }) {
  const { list } = await ctx.params;
  const run = EXPORTS[list];
  if (!run) return new NextResponse('not found', { status: 404 });
  const user = await currentUser();
  if (!user) return new NextResponse('signed out', { status: 401 });
  const q = new URL(req.url).searchParams;
  try {
    const sheet = await withUser(user.id, (tx) => run(tx, q));
    // a byte-order mark, so Excel reads ₹ and names as UTF-8
    return new NextResponse(`\uFEFF${toCsv(sheet.header, sheet.rows)}`, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${csvName(sheet.name)}"`,
        'cache-control': 'private, no-store',
      },
    });
  } catch (err) {
    const code = errorCodeOf(err);
    if (code === 'NOT_AUTHORISED' || code === 'MODULE_OFF') {
      return new NextResponse('not allowed', { status: 403 });
    }
    if (code === 'NOT_FOUND') return new NextResponse('not found', { status: 404 });
    console.error(`export ${list} failed`, err);
    return new NextResponse('could not export', { status: 500 });
  }
}
