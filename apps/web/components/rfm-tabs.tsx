import { ViewTabs } from './view-tabs';

/**
 * RFMs, Request for Materials (ADR 143, 144): one screen for asking and following stock. Request is the
 * form, Transfer the stores' transfers for whoever may see them (TRANSFERS), History what the
 * person asked for. Each person sees only what their access shows: Request only where there
 * is somewhere to ask, a manager's opening Request from a store (`rfmRequestHref`, ADR 149).
 */
export function RfmTabs({
  current,
  transfers,
  request,
}: {
  current: 'ask' | 'transfers' | 'history';
  transfers: boolean;
  request: string | null;
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
          ...(request ? [{ key: 'ask', label: 'Request', href: request }] : []),
          ...(transfers ? [{ key: 'transfers', label: 'Transfer', href: '/stock/transfers' }] : []),
          { key: 'history', label: 'History', href: '/requests?tab=history' },
        ]}
      />
    </div>
  );
}
