// Requests in plain words (ADR 053): pure, so it can be unit tested.

/** A workflow step in plain words, never its code (ADR 053). */
export function stepLabel(step: string): string {
  if (step.endsWith('approval')) return 'needs your approval';
  if (step === 'dispatch') return 'to send';
  if (step === 'receive') return 'to receive';
  if (step === 'review') return 'to review';
  return step.replace(/_/g, ' ');
}
