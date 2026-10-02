// The device position, shared by the Clock screen and the location setting (ADR 018).

export interface Position {
  lat: number | null;
  lng: number | null;
  /** metres, as the browser reports it */
  accuracy: number | null;
}

/**
 * The device position, or nulls when denied, unavailable or slower than 10 s. maxAgeMs:
 * how old a cached fix may be (a clock-in accepts a minute; setting a place wants fresh).
 */
export function currentPosition(maxAgeMs = 60_000): Promise<Position> {
  const none = { lat: null, lng: null, accuracy: null };
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
    return Promise.resolve(none);
  }
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          lat: Math.round(p.coords.latitude * 1e6) / 1e6,
          lng: Math.round(p.coords.longitude * 1e6) / 1e6,
          accuracy: Math.round(p.coords.accuracy),
        }),
      () => resolve(none),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: maxAgeMs },
    ),
  );
}

/** A fix worse than this is too rough to set a place's location from. */
export const ROUGH_ACCURACY_M = 100;

/** OpenStreetMap at the point, to check a pin by eye. */
export function mapLink(lat: number, lng: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng}`;
}
