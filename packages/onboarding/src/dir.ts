import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Reads a customer folder's CSV files into the name -> content map the loader takes. */
export function readCustomerDir(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.csv')) files[name] = readFileSync(join(dir, name), 'utf8');
  }
  return files;
}

/** The folder's dish photos, photos/menu/<dish code>.<ext> (ADR 078): name -> bytes. */
export function readCustomerPhotos(dir: string): Record<string, Uint8Array> {
  const folder = join(dir, 'photos', 'menu');
  const photos: Record<string, Uint8Array> = {};
  if (!existsSync(folder)) return photos;
  for (const name of readdirSync(folder)) {
    if (!name.startsWith('.')) photos[name] = new Uint8Array(readFileSync(join(folder, name)));
  }
  return photos;
}
