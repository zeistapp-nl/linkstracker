import type { Pool } from './db.js';
import { registreerFout } from './db.js';
import { DagSleutels, amsterdamDag, ipHash } from './privacy.js';
import { beoordeelUa } from './bots.js';

export interface RuweKlik {
  linkId: string;
  appId: number;
  ts: Date;
  ip: string;
  ua: string | undefined;
  bron: string;
  /** mens/bot wordt in de worker bepaald; overige classificaties worden vooraf gezet */
  classificatie: 'normaal' | 'inactief' | 'domein_mismatch' | 'neutrale_host';
}

export interface Tellers {
  ontvangen: number;
  opgeslagen: number;
  verworpen: number;
  mislukte_flushes: number;
  onbekend_id: number;
  head: number;
}

/**
 * Begrensde wachtrij voor klikregistratie.
 * - Redirect plaatst alleen een gebeurtenis in geheugen (O(1)), wacht nooit op de database.
 * - Worker schrijft in batches binnen één transactie; bij een fout blijven de gebeurtenissen staan
 *   en wordt opnieuw geprobeerd met oplopende wachttijd.
 * - Bij een volle wachtrij wordt de nieuwste gebeurtenis verworpen en geteld (nooit ongemerkt).
 * - Tellers worden per dag in metriek_dag weggeschreven: ontvangen = opgeslagen + verworpen + in wachtrij.
 * - Bij afsluiten (SIGTERM) wordt de wachtrij leeggeschreven binnen een tijdslimiet.
 */
export class KlikWachtrij {
  private rij: RuweKlik[] = [];
  private timer: NodeJS.Timeout | null = null;
  private bezig = false;
  private wachtTot = 0;
  private backoffMs = 1000;
  private recent = new Map<string, number>(); // dubbelcontrole: link|hash -> tijdstip
  private gemeldeTellers: Tellers;
  tellers: Tellers = { ontvangen: 0, opgeslagen: 0, verworpen: 0, mislukte_flushes: 0, onbekend_id: 0, head: 0 };
  laatsteFlushOk: Date | null = null;
  laatsteFout: string | null = null;
  maxDiepte = 0;

  constructor(
    private pool: Pool,
    private sleutels: DagSleutels,
    private opties: { max: number; batch: number; intervalMs: number; dubbelVensterMs: number },
  ) {
    this.gemeldeTellers = { ...this.tellers };
  }

  get diepte(): number {
    return this.rij.length;
  }

  plaats(k: RuweKlik): boolean {
    this.tellers.ontvangen++;
    if (this.rij.length >= this.opties.max) {
      this.tellers.verworpen++;
      return false;
    }
    this.rij.push(k);
    if (this.rij.length > this.maxDiepte) this.maxDiepte = this.rij.length;
    return true;
  }

  start(): void {
    this.timer = setInterval(() => void this.flush(), this.opties.intervalMs);
    this.timer.unref();
  }

  async stop(timeoutMs = 8000): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    const eind = Date.now() + timeoutMs;
    this.wachtTot = 0;
    while (this.rij.length && Date.now() < eind) {
      const ok = await this.flush(true);
      if (!ok) await new Promise((r) => setTimeout(r, 300));
    }
    if (this.rij.length) {
      this.tellers.verworpen += this.rij.length;
      console.error(JSON.stringify({ niveau: 'fout', soort: 'afsluiten_niet_leeg', verloren: this.rij.length }));
      this.rij = [];
    }
    await this.schrijfTellers().catch(() => {});
  }

  /** Schrijft één batch weg. Geeft true als er niets mis ging. */
  async flush(forceer = false): Promise<boolean> {
    if (this.bezig || !this.rij.length) return true;
    if (!forceer && Date.now() < this.wachtTot) return true;
    this.bezig = true;
    const batch = this.rij.slice(0, this.opties.batch);
    try {
      const { rijen, nieuwRecent } = await this.verrijk(batch);
      await this.schrijf(rijen);
      for (const [k, t] of nieuwRecent) this.recent.set(k, t);
      this.rij.splice(0, batch.length);
      this.tellers.opgeslagen += batch.length;
      this.laatsteFlushOk = new Date();
      this.backoffMs = 1000;
      this.wachtTot = 0;
      return true;
    } catch (e) {
      this.tellers.mislukte_flushes++;
      this.laatsteFout = (e as Error).message;
      this.wachtTot = Date.now() + this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 30000);
      console.error(JSON.stringify({ niveau: 'fout', soort: 'klik_flush', bericht: this.laatsteFout, wachtrij: this.rij.length }));
      return false;
    } finally {
      this.bezig = false;
    }
  }

  private async verrijk(batch: RuweKlik[]) {
    const uit: unknown[][] = [];
    const nieuwRecent = new Map<string, number>();
    const nu = Date.now();
    for (const [k, t] of this.recent) if (nu - t > this.opties.dubbelVensterMs * 2) this.recent.delete(k);
    for (const k of batch) {
      const ua = beoordeelUa(k.ua);
      const dag = amsterdamDag(k.ts);
      const hash = ipHash(await this.sleutels.sleutel(dag), k.ip, ua.klasse);
      const sleutel = `${k.linkId}|${hash}`;
      const vorige = nieuwRecent.get(sleutel) ?? this.recent.get(sleutel);
      const isDubbel = !ua.isBot && vorige !== undefined && k.ts.getTime() - vorige < this.opties.dubbelVensterMs;
      if (!ua.isBot && !isDubbel) nieuwRecent.set(sleutel, k.ts.getTime());
      const classificatie = ua.isBot ? 'bot' : k.classificatie === 'normaal' ? 'mens' : k.classificatie;
      uit.push([k.linkId, k.appId, k.ts.toISOString(), hash, ua.klasse, ua.isBot, isDubbel, k.bron, classificatie]);
    }
    return { rijen: uit, nieuwRecent };
  }

  private async schrijf(rijen: unknown[][]): Promise<void> {
    if (!rijen.length) return;
    const kol = 9;
    const waarden: unknown[] = [];
    const plekken = rijen.map((r, i) => {
      waarden.push(...r);
      return `(${Array.from({ length: kol }, (_, j) => `$${i * kol + j + 1}`).join(',')})`;
    });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO clicks (link_id, app_id, ts, ip_hash, ua_klasse, is_bot, is_dubbel, bron, classificatie) VALUES ${plekken.join(',')}`,
        waarden,
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /** Delta's van tellers naar metriek_dag (aanroepen per minuut). */
  async schrijfTellers(): Promise<void> {
    const delta: [string, number][] = [];
    for (const k of Object.keys(this.tellers) as (keyof Tellers)[]) {
      const d = this.tellers[k] - this.gemeldeTellers[k];
      if (d) delta.push([k, d]);
    }
    if (!delta.length) return;
    const dag = amsterdamDag();
    try {
      for (const [k, d] of delta) {
        await this.pool.query(
          `INSERT INTO metriek_dag (dag, sleutel, waarde) VALUES ($1, $2, $3)
           ON CONFLICT (dag, sleutel) DO UPDATE SET waarde = metriek_dag.waarde + EXCLUDED.waarde`,
          [dag, k, d],
        );
        this.gemeldeTellers[k as keyof Tellers] += d;
      }
      if (delta.some(([k]) => k === 'verworpen')) {
        await registreerFout(this.pool, 'kliks_verworpen', { aantal: delta.find(([k]) => k === 'verworpen')![1] });
      }
    } catch {
      /* volgende minuut opnieuw */
    }
  }
}
