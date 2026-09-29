export const dynamic = 'force-static';

export default function OfflinePage() {
  return (
    <div className="space-y-2 text-center">
      <h1 className="text-xl font-semibold">You&apos;re offline</h1>
      <p className="text-slate-600">Check your connection and try again.</p>
    </div>
  );
}
