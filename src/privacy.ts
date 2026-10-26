import { createHmac, randomBytes } from 'node:crypto';
import type { Pool } from './db.js';

/** Datum (JJJJ-MM-DD) in Nederlandse tijd. */
export function amsterdamDag(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/**
 * Dagsleutels: per kalenderdag (Amsterdam) een willekeurige sleutel, gedeeld via de database
 * zodat meerdere instanties dezelfde identifier maken. Sleutels ouder dan 2 dagen worden gewist,
 * waarna een ip_hash niet meer te herleiden of over dagen te koppelen is.
 */
export class DagSleutels {
  private cache = new Map<string, Buffer>();
  // Noodsleutel als de database onbereikbaar is: alleen in geheugen, nooit opgeslagen
  private nood = new Map<string, Buffer>();

  constructor(private pool: Pool) {}

  async sleutel(dag: string): Promise<Buffer> {
    const c = this.cache.get(dag);
    if (c) return c;
    try {
      const nieuw = randomBytes(32);
      const { rows } = await this.pool.query<{ sleutel: Buffer }>(
        `INSERT INTO dag_sleutels (dag, sleutel) VALUES ($1, $2)
         ON CONFLICT (dag) DO UPDATE SET dag = EXCLUDED.dag RETURNING sleutel`,
        [dag, nieuw],
      );
      this.cache.set(dag, rows[0].sleutel);
      if (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value!);
      return rows[0].sleutel;
    } catch {
      let n = this.nood.get(dag);
      if (!n) { n = randomBytes(32); this.nood.set(dag, n); }
      return n;
    }
  }
}

export function ipHash(sleutel: Buffer, ip: string, uaKlasse: string): string {
  return createHmac('sha256', sleutel).update(`${ip}|${uaKlasse}`).digest('base64url').slice(0, 22);
}
