import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Pool = pg.Pool;

export function maakPool(url: string): pg.Pool {
  const ssl = /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined;
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
    ssl,
  });
  // Een verbroken verbinding mag het proces niet laten crashen
  pool.on('error', (e) => console.error(JSON.stringify({ niveau: 'fout', soort: 'pool', bericht: e.message })));
  return pool;
}

const migratieMap = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migreer(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  const uitgevoerd: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migraties (
      naam text PRIMARY KEY, uitgevoerd timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query<{ naam: string }>('SELECT naam FROM schema_migraties');
    const gedaan = new Set(rows.map((r) => r.naam));
    const bestanden = readdirSync(migratieMap).filter((f) => f.endsWith('.sql')).sort();
    for (const f of bestanden) {
      if (gedaan.has(f)) continue;
      const sql = readFileSync(join(migratieMap, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migraties (naam) VALUES ($1)', [f]);
        await client.query('COMMIT');
        uitgevoerd.push(f);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migratie ${f} mislukt: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
  return uitgevoerd;
}

export async function registreerFout(pool: pg.Pool, soort: string, detail: Record<string, unknown>): Promise<void> {
  console.error(JSON.stringify({ niveau: 'fout', soort, ...detail }));
  await pool.query('INSERT INTO fouten (soort, detail) VALUES ($1, $2)', [soort, detail]).catch(() => {});
}
