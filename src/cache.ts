import type { Pool } from './db.js';

export interface LinkInfo {
  id: string;
  appId: number;
  doelUrl: string;
  actief: boolean;
}

export interface AppInfo {
  id: number;
  slug: string;
  naam: string;
  domein: string;
  fallbackUrl: string;
  utmSource: string;
  rewriteModus: 'uit' | 'dry_run' | 'aan';
  actief: boolean;
}

/**
 * Linkcache met volledige voorlading.
 * - Normaal: een link wordt na CACHE_TTL opnieuw uit de database gelezen.
 * - Databasestoring: de laatst bekende bestemming blijft bruikbaar (stale-on-error),
 *   zodat bestaande links blijven doorsturen. Gevolg: een doel-URL die vlak voor de storing
 *   is gewijzigd kan op een andere instantie nog maximaal TTL de oude waarde gebruiken.
 */
export class Cache {
  private links = new Map<string, { info: LinkInfo; geladen: number }>();
  apps = new Map<number, AppInfo>();
  appsPerDomein = new Map<string, AppInfo>();
  laatsteVolledigeLading = 0;
  dbOk = true;

  constructor(private pool: Pool, private ttlMs: number) {}

  async laadApps(): Promise<void> {
    const { rows } = await this.pool.query(
      `SELECT id, slug, naam, redirect_domein, fallback_url, utm_source, rewrite_modus, actief FROM apps`,
    );
    this.apps.clear();
    this.appsPerDomein.clear();
    for (const r of rows) {
      const a: AppInfo = {
        id: r.id, slug: r.slug, naam: r.naam, domein: r.redirect_domein, fallbackUrl: r.fallback_url,
        utmSource: r.utm_source, rewriteModus: r.rewrite_modus, actief: r.actief,
      };
      this.apps.set(a.id, a);
      this.appsPerDomein.set(a.domein.toLowerCase(), a);
    }
  }

  async laadAlles(): Promise<void> {
    await this.laadApps();
    const { rows } = await this.pool.query(`SELECT id, app_id, doel_url, actief FROM links`);
    const nu = Date.now();
    for (const r of rows) this.links.set(r.id, { info: { id: r.id, appId: r.app_id, doelUrl: r.doel_url, actief: r.actief }, geladen: nu });
    this.laatsteVolledigeLading = nu;
    this.dbOk = true;
  }

  appVoorSlug(slug: string): AppInfo | undefined {
    for (const a of this.apps.values()) if (a.slug === slug) return a;
    return undefined;
  }

  zet(info: LinkInfo): void {
    this.onbekend.delete(info.id);
    this.links.set(info.id, { info, geladen: Date.now() });
  }

  get grootte(): number {
    return this.links.size;
  }

  /** Zoekt een link; null = bestaat niet. Gooit nooit bij databasestoring als er een cachewaarde is. */
  async zoek(id: string): Promise<LinkInfo | null> {
    const c = this.links.get(id);
    if (c) {
      // Verouderd: direct de bekende waarde gebruiken en op de achtergrond verversen (redirect wacht nooit op de database)
      if (Date.now() - c.geladen >= this.ttlMs) this.verversAchtergrond(id);
      return c.info;
    }
    const neg = this.onbekend.get(id);
    if (neg && Date.now() - neg < 60_000) return null;
    return this.leesUitDb(id);
  }

  // Korte negatieve cache tegen scanners die willekeurige id's proberen
  private onbekend = new Map<string, number>();

  private bezig = new Set<string>();
  private verversAchtergrond(id: string): void {
    if (this.bezig.has(id)) return;
    this.bezig.add(id);
    this.leesUitDb(id).catch(() => {}).finally(() => this.bezig.delete(id));
  }

  private async leesUitDb(id: string): Promise<LinkInfo | null> {
    const c = this.links.get(id);
    try {
      const { rows } = await this.pool.query(`SELECT id, app_id, doel_url, actief FROM links WHERE id = $1`, [id]);
      this.dbOk = true;
      if (!rows.length) {
        this.links.delete(id);
        if (this.onbekend.size > 50_000) this.onbekend.clear();
        this.onbekend.set(id, Date.now());
        return null;
      }
      const info: LinkInfo = { id: rows[0].id, appId: rows[0].app_id, doelUrl: rows[0].doel_url, actief: rows[0].actief };
      this.zet(info);
      return info;
    } catch (e) {
      this.dbOk = false;
      if (c) return c.info; // stale-on-error
      throw e;
    }
  }
}
