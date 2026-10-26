import pg from 'pg';
import { maakPool, migreer, type Pool } from '../src/db.js';
import { bouwServer, type Onderdelen } from '../src/server.js';

const BASIS = process.env.TEST_DATABASE_BASIS ?? 'postgres://postgres@localhost:5433';
let teller = 0;

export const ADMIN = 'test-admin-sleutel';
process.env.ADMIN_API_KEY = ADMIN;

export async function nieuweOmgeving(): Promise<Onderdelen & { pool: Pool; opruimen: () => Promise<void>; dbNaam: string }> {
  const dbNaam = `lt_${process.pid}_${Date.now()}_${teller++}`;
  const beheer = new pg.Client({ connectionString: `${BASIS}/postgres` });
  await beheer.connect();
  await beheer.query(`CREATE DATABASE ${dbNaam}`);
  await beheer.end();
  const pool = maakPool(`${BASIS}/${dbNaam}`);
  await migreer(pool);
  // config wordt bij import gelezen; ADMIN_API_KEY moet vóór import van config gezet zijn
  const delen = await bouwServer(pool);
  await delen.cache.laadAlles();
  await delen.app.ready();
  return {
    ...delen, pool, dbNaam,
    opruimen: async () => {
      await delen.app.close();
      await pool.end();
      const b = new pg.Client({ connectionString: `${BASIS}/postgres` });
      await b.connect();
      await b.query(`DROP DATABASE IF EXISTS ${dbNaam} WITH (FORCE)`);
      await b.end();
    },
  };
}

export const H = { 'x-api-key': ADMIN };

export async function rewrite(o: Onderdelen, body: Record<string, unknown>) {
  const r = await o.app.inject({ method: 'POST', url: '/api/rewrite', headers: H, payload: body });
  return { status: r.statusCode, json: r.json() };
}

export async function zetModus(o: Onderdelen, slug: string, modus: string) {
  const r = await o.app.inject({ method: 'PUT', url: `/api/apps/${slug}`, headers: H, payload: { rewrite_modus: modus } });
  if (r.statusCode !== 200) throw new Error(r.body);
}
