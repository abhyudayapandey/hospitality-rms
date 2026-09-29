// Polling for the MVP (CLAUDE.md: realtime -> 30 s polling). Pure so it can be tested
// with fake timers: ticks every intervalMs while the page is visible, pauses while
// hidden, and ticks immediately when the page becomes visible again.

export const POLL_INTERVAL_MS = 30_000;

export interface PollerEnv {
  isVisible(): boolean;
  onVisibilityChange(cb: () => void): () => void;
}

export function startPoller(tick: () => void, intervalMs: number, env: PollerEnv): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const start = () => {
    if (timer === undefined) timer = setInterval(tick, intervalMs);
  };
  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const unsubscribe = env.onVisibilityChange(() => {
    if (env.isVisible()) {
      tick();
      start();
    } else {
      stop();
    }
  });
  if (env.isVisible()) start();
  return () => {
    stop();
    unsubscribe();
  };
}
