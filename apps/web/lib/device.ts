// The device behind a clock-in (ATT-7, ADR 045). Browsers give no hardware id, so the id is a
// random one kept in the phone's browser storage; the model comes from the user agent. Both are
// shown to managers only as flags (a new phone, one phone used by several people), never used to
// block anyone.

/** A random id for this browser, kept in localStorage; "unknown" when storage is blocked. */
export function deviceId(): string {
  try {
    const k = 'oo-device-id';
    let id = localStorage.getItem(k);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(k, id);
    }
    return id;
  } catch {
    return 'unknown';
  }
}

/**
 * The phone model from a user agent string: the model of an Android phone ("Pixel 7"), "iPhone"
 * or "iPad", else null. User agents are frozen or reduced on many browsers, so this is a hint.
 */
export function phoneModel(ua: string): string | null {
  const android = /Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?[;)]/.exec(ua);
  if (android) {
    const m = android[1]!.trim();
    // Chrome's reduced user agent says "K" instead of the model
    if (m && m !== 'K' && !/^Linux/.test(m)) return m.slice(0, 80);
  }
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  return null;
}

/** This browser's device id and model, for hr.clock. */
export function thisDevice(): { deviceId: string; deviceModel: string | null } {
  return {
    deviceId: deviceId(),
    deviceModel: typeof navigator === 'undefined' ? null : phoneModel(navigator.userAgent),
  };
}
