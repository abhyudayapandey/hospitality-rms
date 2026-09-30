'use client';

import { RequestDecision } from '@/components/request-decision';
import { approveSwap } from '../../actions';

export function SwapDecision({ swap, requestId }: { swap: string; requestId: string }) {
  return (
    <RequestDecision requestId={requestId} back="/inbox" approve={() => approveSwap(swap, '')} />
  );
}
