import { loadShell } from '@/lib/shell';

export default async function StockPage() {
  const shell = await loadShell();
  if (!shell.domains.has('STOCK_LEVELS')) {
    return <p className="text-slate-600">You don&apos;t have access to stock.</p>;
  }
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Stock</h1>
      <p className="rounded-xl bg-white p-6 text-center text-slate-600 ring-1 ring-slate-200">
        Coming soon.
      </p>
    </div>
  );
}
