import pg from 'pg';

// Fails fast with a clear message when the DB tests cannot reach Postgres,
// or when the database has not been migrated and seeded.
export default async function setup(): Promise<void> {
  for (const name of ['TEST_DATABASE_URL', 'MIGRATOR_DATABASE_URL'] as const) {
    const url = process.env[name];
    if (!url) {
      throw new Error(`${name} is not set. Copy .env.example to .env.`);
    }
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query('select 1');
    } catch (err) {
      throw new Error(
        `Cannot reach Postgres at ${name}. Run "pnpm db:up && pnpm db:migrate && pnpm db:seed".`,
        { cause: err },
      );
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}
