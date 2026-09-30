import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Reads a customer folder's CSV files into the name -> content map the loader takes. */
export function readCustomerDir(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.csv')) files[name] = readFileSync(join(dir, name), 'utf8');
  }
  return files;
}
