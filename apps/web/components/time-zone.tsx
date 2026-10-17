'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { DEFAULT_TZ } from '@/lib/dates';

// The person's workplace time zone for client forms (ADR 169): what "today" is when a form
// suggests or limits a date. The app layout sets it from the shell.
const TimeZone = createContext<string>(DEFAULT_TZ);

export function TimeZoneProvider({ tz, children }: { tz: string; children: ReactNode }) {
  return <TimeZone.Provider value={tz}>{children}</TimeZone.Provider>;
}

export const useTimeZone = () => useContext(TimeZone);
