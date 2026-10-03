import { redirect } from 'next/navigation';
import { param, type SearchParams } from '@/lib/params';

// The Variance screen became the Cost of sales report (R-2, ADR 028, UX U-14). Old links
// and bookmarks land there, with their dates.
export default async function VariancePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const from = param(sp, 'from');
  const to = param(sp, 'to');
  redirect(from && to ? `/reports/cost?period=custom&from=${from}&to=${to}` : '/reports/cost');
}
