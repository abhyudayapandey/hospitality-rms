'use client';

import { useCallback, useEffect, useState } from 'react';
import { messageFor, isErrorCode } from '@outlet-ops/domain';
import { turnOffAlerts, turnOnAlerts } from '@/app/(app)/push/actions';
import { Icon } from './icon';
import { primaryButton, secondaryButton } from './messages';

// Alerts on this phone (ADR 137): what lands in the bell also shows on the lock screen. Home
// asks once ("Not now" is kept on this phone); Profile turns it on or off any time. An iPhone
// shows alerts only from the app added to its Home Screen, so Safari says how to do that.

type State = 'loading' | 'unsupported' | 'ios-browser' | 'blocked' | 'on' | 'off';

const ASKED = 'oo.alerts.asked';
const SYNCED = 'oo.alerts.synced';

function store(key: string, value?: string): string | null {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function isIos(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

function deviceLabel(): string {
  if (isIos()) return 'iPhone';
  if (/Android/.test(navigator.userAgent)) return 'Android phone';
  return 'Computer';
}

function supported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ?? (await navigator.serviceWorker.register('/sw.js', { scope: '/' }));
}

function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** The phone's subscription, if it was made with today's key (a rotated key drops it). */
async function current(
  reg: ServiceWorkerRegistration | null | undefined,
  publicKey: string,
): Promise<PushSubscription | null> {
  const sub = (await reg?.pushManager.getSubscription()) ?? null;
  const key = sub?.options?.applicationServerKey;
  if (sub && key && new Uint8Array(key).join() !== keyBytes(publicKey).join()) {
    await sub.unsubscribe().catch(() => false);
    return null;
  }
  return sub;
}

function asPhone(sub: PushSubscription) {
  const json = sub.toJSON();
  return {
    endpoint: sub.endpoint,
    p256dh: json.keys?.p256dh ?? '',
    auth: json.keys?.auth ?? '',
  };
}

function usePhoneAlerts(publicKey: string, who: string) {
  const [state, setState] = useState<State>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      if (!supported()) {
        const standalone =
          window.matchMedia('(display-mode: standalone)').matches ||
          (navigator as { standalone?: boolean }).standalone === true;
        if (live) setState(isIos() && !standalone ? 'ios-browser' : 'unsupported');
        return;
      }
      if (Notification.permission === 'denied') {
        if (live) setState('blocked');
        return;
      }
      const reg = await registration().catch(() => null);
      const sub = await current(reg, publicKey).catch(() => null);
      if (!live) return;
      setState(sub ? 'on' : 'off');
      // a phone shared at shift change: its alerts follow whoever is signed in now
      if (sub && store(SYNCED) !== `${who}|${sub.endpoint}`) {
        const r = await turnOnAlerts(asPhone(sub), deviceLabel());
        if (r.ok) store(SYNCED, `${who}|${sub.endpoint}`);
      }
    })();
    return () => {
      live = false;
    };
  }, [who, publicKey]);

  const turnOn = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'blocked' : 'off');
        return false;
      }
      const reg = await registration();
      if (!reg) throw new Error('no service worker');
      const sub =
        (await current(reg, publicKey)) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(publicKey),
        }));
      const r = await turnOnAlerts(asPhone(sub), deviceLabel());
      if (!r.ok) {
        setError(isErrorCode(r.code) ? messageFor(r.code) : r.message);
        return false;
      }
      store(SYNCED, `${who}|${sub.endpoint}`);
      setState('on');
      return true;
    } catch {
      setError("This phone couldn't turn on alerts. Try again later.");
      return false;
    } finally {
      setBusy(false);
    }
  }, [publicKey, who]);

  const turnOff = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const reg = await registration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await turnOffAlerts(sub.endpoint);
        await sub.unsubscribe();
      }
      setState('off');
    } finally {
      setBusy(false);
    }
  }, []);

  return { state, error, busy, turnOn, turnOff };
}

const IOS_STEPS =
  'On iPhone, add Outlet Ops to your Home Screen first. Tap Share, then Add to Home Screen. Then open it from there.';

/** Home: asks once whether this phone should show alerts. */
export function PhoneAlertsCard({ publicKey, who }: { publicKey: string; who: string }) {
  const { state, error, busy, turnOn } = usePhoneAlerts(publicKey, who);
  const [asked, setAsked] = useState(true);
  useEffect(() => setAsked(store(ASKED) === '1'), []);
  const done = () => {
    store(ASKED, '1');
    setAsked(true);
  };
  if (asked || (state !== 'off' && state !== 'ios-browser')) return null;
  return (
    <section
      aria-label="Alerts on this phone"
      className="space-y-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
      data-testid="alerts-card"
    >
      <p className="flex items-center gap-3 font-semibold">
        <Icon name="bell" className="size-6 text-brand-700" />
        Get alerts on this phone?
      </p>
      <p className="text-sm text-slate-600">
        {state === 'ios-browser'
          ? IOS_STEPS
          : 'Know at once when you get a task, a shift or a yes or no.'}
      </p>
      {error && (
        <p role="alert" className="text-sm text-rose-700">
          {error}
        </p>
      )}
      {state === 'ios-browser' ? (
        <button type="button" onClick={done} className={secondaryButton}>
          OK
        </button>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={done} disabled={busy} className={secondaryButton}>
            Not now
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void turnOn().then((ok) => ok && done())}
            className={primaryButton}
            data-testid="alerts-turn-on"
          >
            Turn on
          </button>
        </div>
      )}
    </section>
  );
}

/** Profile: this phone's alerts, on or off. */
export function PhoneAlertsRow({ publicKey, who }: { publicKey: string; who: string }) {
  const { state, error, busy, turnOn, turnOff } = usePhoneAlerts(publicKey, who);
  const text: Record<State, string> = {
    loading: '',
    unsupported: "This phone or browser can't show alerts.",
    'ios-browser': IOS_STEPS,
    blocked: 'Alerts are blocked. Allow them for Outlet Ops in the phone settings.',
    on: 'Alerts are on for this phone.',
    off: 'Alerts are off for this phone.',
  };
  return (
    <div className="space-y-2" data-testid="alerts-row" data-state={state}>
      <p className="text-sm text-slate-700">{text[state]}</p>
      {error && (
        <p role="alert" className="text-sm text-rose-700">
          {error}
        </p>
      )}
      {state === 'off' && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void turnOn()}
          className={primaryButton}
          data-testid="alerts-turn-on"
        >
          Turn on alerts
        </button>
      )}
      {state === 'on' && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void turnOff()}
          className={secondaryButton}
          data-testid="alerts-turn-off"
        >
          Turn off alerts
        </button>
      )}
    </div>
  );
}
