import { z } from 'zod';

// A demo request from the website's "Get a Senior" form (ADR 141). The form's choices map to
// the codes platform.add_demo_request stores; the database checks every field again.

export const OUTLET_KINDS = {
  Hotel: 'hotel',
  'Bar & pub': 'bar',
  Restaurant: 'restaurant',
  QSR: 'qsr',
  'Cloud kitchen': 'cloud_kitchen',
  'Franchise (many outlets)': 'franchise',
  'Several kinds': 'several',
} as const;

export const OUTLET_COUNTS = {
  '1': '1',
  '2 to 5': '2-5',
  '6 to 20': '6-20',
  'More than 20': '20+',
} as const;

const label = <T extends Record<string, string>>(map: T) =>
  z.enum(Object.keys(map) as [keyof T & string, ...(keyof T & string)[]]).transform((k) => map[k]!);

export const demoRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{10,20}$/),
  email: z
    .union([z.literal(''), z.string().trim().max(200).email()])
    .optional()
    .default(''),
  business: z.string().trim().min(1).max(200),
  outletKind: label(OUTLET_KINDS),
  outlets: label(OUTLET_COUNTS),
  /** the bots' trap: a person never sees this field, so it is always empty */
  website: z.string().max(500).optional().default(''),
});

export type DemoRequest = z.output<typeof demoRequestSchema>;
