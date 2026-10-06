// Outlet formats follow the SOP manuals in docs/sop/ (ADR 062): one per kind of business.
// A format is what a role's duties can differ by (file 06 `outlet_format`, ADR 059) and what
// an outlet template is built for. A small hotel is the hotel format with fewer departments;
// a franchise is an owner over outlets of any format, not a format.

export const OUTLET_FORMATS = ['restaurant', 'bar_pub', 'qsr', 'cloud_kitchen', 'hotel'] as const;
export type OutletFormat = (typeof OUTLET_FORMATS)[number];

export const FORMAT_INFO: Readonly<Record<OutletFormat, { name: string; sop: string }>> = {
  restaurant: { name: 'Restaurant / Café', sop: 'standalone-restaurant' },
  bar_pub: { name: 'Bar / Pub', sop: 'bar-pub-microbrewery' },
  qsr: { name: 'Quick service', sop: 'qsr-chain' },
  cloud_kitchen: { name: 'Delivery-only kitchen', sop: 'cloud-kitchen-virtual-brands' },
  hotel: { name: 'Hotel / Resort', sop: 'full-service-hotel-resort' },
};

/** The codes used before ADR 062. Files that still use them load as the new codes. */
export const OLD_FORMAT_CODES: Readonly<Record<string, OutletFormat>> = {
  full_hotel: 'hotel',
  small_hotel: 'hotel',
  standalone_bar: 'bar_pub',
};

/** A format code, an old one read as its new code; undefined when it is neither. */
export function outletFormat(code: string): OutletFormat | undefined {
  const c = OLD_FORMAT_CODES[code] ?? code;
  return (OUTLET_FORMATS as readonly string[]).includes(c) ? (c as OutletFormat) : undefined;
}
