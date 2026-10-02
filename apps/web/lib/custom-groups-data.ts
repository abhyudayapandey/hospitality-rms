import 'server-only';
import { sql, type Tx } from './db';

export interface CustomGroup {
  code: string;
  name: string;
  rights: Record<string, 'view' | 'modify'>;
  acts_as: string[];
  sensitive: boolean;
  holders: number;
}

/** The company's own groups (core.custom_groups refuses anyone but user admins and the owner). */
export async function customGroups(tx: Tx): Promise<CustomGroup[]> {
  return (
    await sql<CustomGroup>`select code, name, rights, acts_as, sensitive, holders
                             from core.custom_groups()`.execute(tx)
  ).rows;
}
