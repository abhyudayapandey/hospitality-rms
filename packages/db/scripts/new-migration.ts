// pnpm db:new <name>: a new dbmate migration named after the newest file (ADR 169), never
// from today's clock alone, so it sorts after every file already applied.
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrationFileName } from '../src/migration-names';

const dir = join(import.meta.dirname, '..', 'migrations');
const name = process.argv.slice(2).join(' ');
const file = migrationFileName(readdirSync(dir), name, new Date());
writeFileSync(join(dir, file), '-- migrate:up\n\n-- migrate:down\n', { flag: 'wx' });
console.log(`created packages/db/migrations/${file}`);
