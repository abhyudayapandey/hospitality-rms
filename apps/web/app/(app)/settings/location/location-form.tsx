'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  ErrorBox,
  inputClass,
  primaryButton,
  secondaryButton,
  StatusBox,
} from '@/components/messages';
import { currentPosition, mapLink, ROUGH_ACCURACY_M } from '@/lib/geo';
import { setPlaceLocation } from './actions';

interface Props {
  place: {
    id: string;
    name: string;
    lat: number | null;
    lng: number | null;
    radius: number;
    setBy: string | null;
    setAt: string | null;
  };
}

export function LocationForm({ place }: Props) {
  const router = useRouter();
  const [lat, setLat] = useState(place.lat?.toString() ?? '');
  const [lng, setLng] = useState(place.lng?.toString() ?? '');
  const [radius, setRadius] = useState(place.radius.toString());
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [locating, setLocating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const latN = Number(lat);
  const lngN = Number(lng);
  const valid = lat !== '' && lng !== '' && Number.isFinite(latN) && Number.isFinite(lngN);

  async function useMine() {
    setLocating(true);
    setError(null);
    const p = await currentPosition(0);
    setLocating(false);
    if (p.lat === null || p.lng === null) {
      setError('Your location couldn’t be read. Allow location for this site and try again.');
      return;
    }
    setLat(p.lat.toString());
    setLng(p.lng.toString());
    setAccuracy(p.accuracy);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const r = await setPlaceLocation({
      node: place.id,
      lat: latN,
      lng: lngN,
      radius: Number(radius),
    });
    setBusy(false);
    if (r.ok) {
      setSaved(true);
      router.refresh();
    } else {
      setError(r.message);
    }
  }

  return (
    <form
      onSubmit={(e) => void save(e)}
      className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
    >
      <div>
        <h2 className="font-semibold">{place.name}</h2>
        <p className="text-xs text-slate-500" data-testid="location-source">
          {place.setBy
            ? `Set in the app by ${place.setBy} on ${place.setAt}`
            : place.lat === null
              ? 'No location yet: clock-ins are not checked'
              : 'From the onboarding files'}
        </p>
      </div>
      <button
        type="button"
        onClick={() => void useMine()}
        disabled={locating}
        className={secondaryButton}
      >
        {locating ? 'Finding you…' : 'Use my current location'}
      </button>
      {accuracy !== null && (
        <p
          data-testid="location-accuracy"
          className={`text-sm ${accuracy > ROUGH_ACCURACY_M ? 'text-amber-800' : 'text-slate-600'}`}
        >
          Accurate to about ± {accuracy} m.
          {accuracy > ROUGH_ACCURACY_M &&
            ' That is rough: step outside or wait a moment, then try again.'}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-sm">
          Latitude
          <input
            inputMode="decimal"
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            className={inputClass}
            name="latitude"
          />
        </label>
        <label className="block text-sm">
          Longitude
          <input
            inputMode="decimal"
            value={lng}
            onChange={(e) => setLng(e.target.value)}
            className={inputClass}
            name="longitude"
          />
        </label>
      </div>
      <label className="block text-sm">
        Clock-in radius (metres, 10 to 5000)
        <input
          type="number"
          min={10}
          max={5000}
          value={radius}
          onChange={(e) => setRadius(e.target.value)}
          className={inputClass}
          name="radius"
        />
      </label>
      {valid && (
        <a
          href={mapLink(latN, lngN)}
          target="_blank"
          rel="noopener noreferrer"
          className="block text-sm font-medium text-sky-700 underline"
          data-testid="map-link"
        >
          Check the pin on a map
        </a>
      )}
      <ErrorBox message={error} />
      <StatusBox message={saved ? 'Saved. The next clock-in uses it.' : null} />
      <button type="submit" disabled={busy || !valid} className={primaryButton}>
        {busy ? 'Saving…' : 'Save location'}
      </button>
    </form>
  );
}
