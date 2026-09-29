import pg from 'pg';

// Fails fast with a clear message when the DB tests cannot reach Postgres.
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set. Copy .env.example to .env.');
  }
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await client.query('select 1');
  } catch (err) {
    throw new Error(
      'Cannot reach Postgres at TEST_DATABASE_URL. Run "pnpm db:up && pnpm db:migrate".',
      { cause: err },
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}
