import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};

/**
 * False on the server and during hydration, true once React runs in the browser. Forms
 * that submit through onSubmit (no action) keep their submit button disabled until then:
 * a tap before hydration would do a plain GET to the same page and lose the input, which
 * is likely on a slow phone.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
