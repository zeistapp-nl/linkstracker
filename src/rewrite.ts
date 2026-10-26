import { randomInt } from 'node:crypto';
import type { Pool } from './db.js';
import type { Cache, AppInfo } from './cache.js';
import { config, normaliseerBron } from './config.js';
import { vindLinks, vervangHrefs, alleenHrefsGewijzigd } from './html.js';
import { beoordeelUrl, sleutelUrl, metUtm, slugCampagne, hostVan } from './url.js';

const ALFABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export function nieuwId(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALFABET[randomInt(ALFABET.length)];
  return s;
}

export interface RewriteInvoer {
  app: string;
  cms_item_id: string;
  rubriek?: string;
  pagina_titel?: string;
  html: string;
  bron?: string;
  dry_run?: boolean;
}

export interface RewriteLink {
  id: string | null;
  status: 'nieuw' | 'bestaand' | 'al_getrackt' | 'overgeslagen' | 'geweigerd';
  label: string;
  oorspronkelijke_url: string;
  doel_url?: string;
  reden?: string;
}

export interface RewriteUitvoer {
  html: string;
  modus: 'uit' | 'dry_run' | 'aan';
  gevonden: number;
  gewijzigd: number;
  nieuw: number;
  bestaand: number;
  links: RewriteLink[];
  waarschuwingen: string[];
}

export class RewriteFout extends Error {
  constructor(public status: number, bericht: string) {
    super(bericht);
  }
}

const STIL_OVERSLAAN = /^(protocol_(mailto|tel|sms|whatsapp|ftp|geo|maps|intent|zeistapp|gooisemerenapp|businessapps)|geen_absolute_url|leeg)$/;

export async function herschrijf(pool: Pool, cache: Cache, invoer: RewriteInvoer, client: string): Promise<RewriteUitvoer> {
  const app = cache.appVoorSlug(invoer.app);
  if (!app || !app.actief) throw new RewriteFout(400, `Onbekende of inactieve app: ${invoer.app}`);
  if (typeof invoer.html !== 'string') throw new RewriteFout(400, 'html ontbreekt');
  if (invoer.html.length > 2_000_000) throw new RewriteFout(413, 'html te groot (max 2 MB)');
  const itemId = String(invoer.cms_item_id ?? '').trim();
  if (!itemId || itemId.length > 100) throw new RewriteFout(400, 'cms_item_id ontbreekt of is te lang');
  const bron = normaliseerBron(invoer.bron);
  if (bron === 'onbekend') throw new RewriteFout(400, `Onbekende bron: ${invoer.bron}`);

  const modus: RewriteUitvoer['modus'] = invoer.dry_run ? 'dry_run' : app.rewriteModus;
  const gevonden = vindLinks(invoer.html);
  const waarschuwingen: string[] = [];
  const resultaat: RewriteLink[] = [];

  if (modus === 'uit') {
    return { html: invoer.html, modus, gevonden: gevonden.length, gewijzigd: 0, nieuw: 0, bestaand: 0, links: [], waarschuwingen: ['tracking staat uit voor deze app'] };
  }

  const eigenDomeinen = new Map<string, AppInfo>();
  for (const a of cache.apps.values()) eigenDomeinen.set(a.domein.toLowerCase(), a);

  type Kandidaat = { idx: number; url: URL; sleutel: string; volgnr: number; label: string; ruw: string };
  const kandidaten: Kandidaat[] = [];
  const telling = new Map<string, number>();

  gevonden.forEach((l, idx) => {
    const ruw = l.href;
    const oordeel = beoordeelUrl(ruw);
    if (!oordeel.ok) {
      const stil = STIL_OVERSLAAN.test(oordeel.reden);
      resultaat[idx] = { id: null, status: stil ? 'overgeslagen' : 'geweigerd', label: l.label, oorspronkelijke_url: ruw, reden: oordeel.reden };
      if (!stil) waarschuwingen.push(`Link "${l.label || ruw.slice(0, 60)}" niet herschreven: ${oordeel.reden}`);
      return;
    }
    const host = oordeel.url.hostname.toLowerCase();
    const eigen = eigenDomeinen.get(host);
    if (eigen || cache.isEigenHost(host)) {
      const m = oordeel.url.pathname.match(/^\/r\/([A-Za-z0-9]{8})$/);
      if (eigen && !cache.publiekDomein && eigen.id !== app.id) waarschuwingen.push(`Trackinglink van andere app (${eigen.slug}) gevonden: ${ruw}`);
      resultaat[idx] = { id: m?.[1] ?? null, status: 'al_getrackt', label: l.label, oorspronkelijke_url: ruw };
      return;
    }
    const kaal = hostVan(oordeel.url);
    if (config.nietHerschrijven.some((h) => kaal === h || kaal.endsWith('.' + h))) {
      resultaat[idx] = { id: null, status: 'overgeslagen', label: l.label, oorspronkelijke_url: ruw, reden: 'uitgezonderde_host' };
      return;
    }
    const sleutel = sleutelUrl(oordeel.url);
    const volgnr = (telling.get(sleutel) ?? 0) + 1;
    telling.set(sleutel, volgnr);
    kandidaten.push({ idx, url: oordeel.url, sleutel, volgnr, label: l.label, ruw });
  });

  const db = await pool.connect();
  const vervangingen: { start: number; eind: number; nieuweHref: string; quote: string }[] = [];
  let nieuw = 0;
  let bestaand = 0;
  const cacheUpdates: { id: string; doel: string }[] = [];
  try {
    await db.query('BEGIN');
    // Voorkomt dat twee gelijktijdige verwerkingen van dezelfde pagina dubbele links maken
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${app.id}|${itemId}`]);
    const { rows: bestaandeRijen } = await db.query(
      `SELECT id, sleutel_url, volgnr, doel_url, handmatig_vast FROM links WHERE app_id = $1 AND cms_item_id = $2`,
      [app.id, itemId],
    );
    const bekend = new Map(bestaandeRijen.map((r) => [`${r.sleutel_url}|${r.volgnr}`, r]));
    const ondernemer = await zoekOndernemers(db, app.id, itemId, kandidaten.map((k) => hostVan(k.url)));

    for (const k of kandidaten) {
      const doel = metUtm(k.url, {
        source: app.utmSource,
        medium: bron,
        campaign: slugCampagne(invoer.rubriek),
        uitzonderingen: config.utmUitzonderingen,
      }).url;
      const ondernemerId = ondernemer.perCmsItem ?? ondernemer.perHost.get(hostVan(k.url)) ?? null;
      const oud = bekend.get(`${k.sleutel}|${k.volgnr}`);
      let id: string;
      let doelGebruikt = doel;
      if (oud) {
        id = oud.id;
        bestaand++;
        if (oud.handmatig_vast) {
          doelGebruikt = oud.doel_url;
          if (oud.doel_url !== doel) waarschuwingen.push(`Link ${id} heeft een handmatig vastgezette bestemming; nieuwe bestemming genegeerd`);
        } else if (oud.doel_url !== doel) {
          await db.query(`INSERT INTO link_wijzigingen (link_id, veld, oud, nieuw, door) VALUES ($1,'doel_url',$2,$3,$4)`, [id, oud.doel_url, doel, `rewrite:${client}`]);
        }
        await db.query(
          `UPDATE links SET rubriek = $2, pagina_titel = $3, label = $4, oorspronkelijke_url = $5, doel_url = $6,
             ondernemer_id = COALESCE(ondernemer_id, $7), actief = true, bijgewerkt = now() WHERE id = $1`,
          [id, invoer.rubriek ?? null, invoer.pagina_titel ?? null, k.label || null, k.ruw, doelGebruikt, ondernemerId],
        );
      } else {
        id = await voegToe(db, [app.id, itemId, invoer.rubriek ?? null, invoer.pagina_titel ?? null, k.sleutel, k.volgnr, k.ruw, doel, k.label || null, ondernemerId]);
        nieuw++;
      }
      cacheUpdates.push({ id, doel: doelGebruikt });
      const redirect = `https://${cache.linkDomein(app)}/r/${id}${bron === 'app' ? '' : `?b=${bron}`}`;
      const g = gevonden[k.idx];
      vervangingen.push({ start: g.start, eind: g.eind, nieuweHref: redirect, quote: g.quote });
      resultaat[k.idx] = { id: modus === 'aan' || oud ? id : null, status: oud ? 'bestaand' : 'nieuw', label: k.label, oorspronkelijke_url: k.ruw, doel_url: doelGebruikt };
    }

    const nieuweHtml = vervangHrefs(invoer.html, vervangingen);
    if (!alleenHrefsGewijzigd(invoer.html, nieuweHtml)) {
      throw new RewriteFout(500, 'Veiligheidscontrole: herschreven HTML wijkt buiten de links af; niets opgeslagen');
    }
    await db.query(
      `INSERT INTO verwerkingen (app_id, cms_item_id, bron, modus, gevonden, gewijzigd, nieuw, waarschuwingen, client)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [app.id, itemId, bron, modus, gevonden.length, vervangingen.length, nieuw, JSON.stringify(waarschuwingen), client],
    );
    if (modus === 'aan') {
      await db.query('COMMIT');
      for (const u of cacheUpdates) cache.zet({ id: u.id, appId: app.id, doelUrl: u.doel, actief: true });
      return { html: nieuweHtml, modus, gevonden: gevonden.length, gewijzigd: vervangingen.length, nieuw, bestaand, links: resultaat.filter(Boolean), waarschuwingen };
    }
    // dry_run: alles terugdraaien, maar wel vastleggen dat er een proefverwerking was
    await db.query('ROLLBACK');
    await pool.query(
      `INSERT INTO verwerkingen (app_id, cms_item_id, bron, modus, gevonden, gewijzigd, nieuw, waarschuwingen, client)
       VALUES ($1,$2,$3,'dry_run',$4,$5,$6,$7,$8)`,
      [app.id, itemId, bron, gevonden.length, vervangingen.length, nieuw, JSON.stringify(waarschuwingen), client],
    );
    return { html: invoer.html, modus, gevonden: gevonden.length, gewijzigd: 0, nieuw, bestaand, links: resultaat.filter(Boolean), waarschuwingen: [...waarschuwingen, `proefmodus: ${vervangingen.length} link(s) zouden worden herschreven`] };
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

async function voegToe(db: import('pg').PoolClient, waarden: unknown[]): Promise<string> {
  for (let poging = 0; poging < 5; poging++) {
    const id = nieuwId();
    try {
      await db.query('SAVEPOINT nieuw_id');
      await db.query(
        `INSERT INTO links (id, app_id, cms_item_id, rubriek, pagina_titel, sleutel_url, volgnr, oorspronkelijke_url, doel_url, label, ondernemer_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, ...waarden],
      );
      await db.query('RELEASE SAVEPOINT nieuw_id');
      return id;
    } catch (e) {
      await db.query('ROLLBACK TO SAVEPOINT nieuw_id');
      if ((e as { constraint?: string }).constraint !== 'links_pkey') throw e;
    }
  }
  throw new Error('Kon geen uniek link-id maken');
}

async function zoekOndernemers(db: import('pg').PoolClient, appId: number, itemId: string, hosts: string[]) {
  const { rows } = await db.query(
    `SELECT k.type, k.waarde, k.ondernemer_id FROM ondernemer_koppelingen k
       JOIN ondernemers o ON o.id = k.ondernemer_id AND o.app_id = $1 AND o.actief
      WHERE (k.type = 'cms_item' AND k.waarde = $2) OR (k.type = 'host' AND k.waarde = ANY($3))`,
    [appId, itemId, hosts],
  );
  const perHost = new Map<string, number>();
  let perCmsItem: number | undefined;
  for (const r of rows) {
    if (r.type === 'cms_item') perCmsItem = r.ondernemer_id;
    else perHost.set(r.waarde, r.ondernemer_id);
  }
  return { perHost, perCmsItem };
}
