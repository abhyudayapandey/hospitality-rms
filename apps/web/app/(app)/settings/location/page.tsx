import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { formatDay, formatTime, localDate } from '@/lib/dates';
import { sql, withUser } from '@/lib/db';
import { LocationForm } from './location-form';

// Outlet location (ADR 018): the GM, AGM or Account Owner sets where each outlet or site
// is and how far from it a clock-in counts as there. File 04 sets the same values; a
// later import warns before replacing what was set here.

interface Place {
  node_id: string;
  code: string | null;
  name: string;
  latitude: string | null;
  longitude: string | null;
  geofence_radius_m: number | null;
  set_in_app_by: string | null;
  set_in_app_at: Date | null;
  timezone: string;
}

export default async function LocationPage() {
  const user = await requireUser();
  const places = await withUser(user.id, async (tx) => {
    const r = await sql<Place>`
      select node_id, code, name, latitude::text, longitude::text, geofence_radius_m,
             set_in_app_by, set_in_app_at, timezone
        from hr.location_places()`.execute(tx);
    return r.rows;
  });
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Outlet location</h1>
        <p className="text-sm text-slate-600">
          Clock-ins further than the radius are flagged for the manager, never blocked. A change
          applies from the next clock-in.
        </p>
      </div>
      {places.length === 0 ? (
        <Empty>You can&apos;t set the location of any place.</Empty>
      ) : (
        <ul className="space-y-4">
          {places.map((p) => (
            <li key={p.node_id} data-testid="location-place" data-code={p.code ?? ''}>
              <LocationForm
                place={{
                  id: p.node_id,
                  name: p.name,
                  lat: p.latitude === null ? null : Number(p.latitude),
                  lng: p.longitude === null ? null : Number(p.longitude),
                  radius: p.geofence_radius_m ?? 150,
                  setBy: p.set_in_app_by,
                  setAt: p.set_in_app_at
                    ? `${formatDay(localDate(p.set_in_app_at, p.timezone))}, ${formatTime(p.set_in_app_at, p.timezone)}`
                    : null,
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
