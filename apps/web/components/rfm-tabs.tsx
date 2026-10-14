import { ViewTabs } from './view-tabs';

/**
 * RFMs, Request for Materials (ADR 143, 144): one screen for asking and following stock. Request is the
 * form, Transfer the stores' transfers for whoever may see them (TRANSFERS), History what the
 * person asked for. Each person sees only what their access shows.
 */
export function RfmTabs({
  current,
  transfers,
}: {
  current: 'ask' | 'transfers' | 'history';
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
          { key: 'ask', label: 'Request', href: '/requests?tab=ask' },
          ...(transfers ? [{ key: 'transfers', label: 'Transfer', href: '/stock/transfers' }] : []),
          { key: 'history', label: 'History', href: '/requests?tab=history' },
        ]}
      />
    </div>
  );
}
