import { ViewTabs } from './view-tabs';

/**
 * RFMs, Requests for Materials (ADR 143): one screen for asking and following stock. Ask is
 * the form, Previous asks every request and ask, Transfers the stores' moves for whoever may
 * see them (TRANSFERS). Each person sees only what their access shows.
 */
export function RfmTabs({
  current,
  transfers,
}: {
  current: 'ask' | 'asked' | 'transfers';
  transfers: boolean;
}) {
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">
        RFMs
        <span className="block text-sm font-normal text-slate-500">Request for Materials</span>
      </h1>
      <ViewTabs
        label="RFMs"
        current={current}
        tabs={[
          { key: 'ask', label: 'Ask', href: '/requests?tab=ask' },
          { key: 'asked', label: 'Previous asks', href: '/requests?tab=asked' },
          ...(transfers
            ? [{ key: 'transfers', label: 'Transfers', href: '/stock/transfers' }]
            : []),
        ]}
      />
    </div>
  );
}
