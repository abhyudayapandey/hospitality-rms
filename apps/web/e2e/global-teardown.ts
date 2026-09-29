import { join } from 'node:path';
import { runExecutor } from './helpers';

// Drains the workflow outbox with the real executor so an interrupted run leaves no
// approved-but-unexecuted requests behind for the DB and executor tests.
export default async function globalTeardown(): Promise<void> {
  try {
    process.loadEnvFile(join(import.meta.dirname, '..', '..', '..', '.env'));
  } catch {
    // CI passes env vars directly
  }
  await runExecutor();
}
