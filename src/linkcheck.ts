import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import type { LookupFunction } from 'node:net';
import type { Pool } from './db.js';
import { beoordeelUrl, isPriveIp } from './url.js';

export type Resultaat = 'ok' | 'tijdelijk' | 'definitief' | 'dns' | 'timeout' | 'loop' | 'ongeldig';

const UA = 'Mozilla/5.0 (compatible; BuurtAppsLinkcheck/1.0; +https://www.zeistapp.nl/)';

/** DNS-lookup die privé- en interne adressen weigert (ook bij DNS-rebinding, want de verbinding gebruikt dit adres). */
let privéToestaan = false;
/** Alleen voor geautomatiseerde tests met een lokale testserver. */
export function _testStaPriveToe(v: boolean) { privéToestaan = v; }

const veiligeLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { all: true }, (err, adressen) => {
    if (err) return (callback as (e: Error | null, a: string, f: number) => void)(err, '', 4);
    const lijst = adressen as dns.LookupAddress[];
    const verboden = privéToestaan ? undefined : lijst.find((a) => isPriveIp(a.address));
    if (verboden || !lijst.length) {
      const e = Object.assign(new Error('prive_adres'), { code: 'PRIVE_ADRES' });
      return (callback as (e: Error | null, a: string, f: number) => void)(e, '', 4);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, lijst);
    (callback as (e: null, a: string, f: number) => void)(null, lijst[0].address, lijst[0].family);
  });
};

interface Antwoord { status: number; locatie?: string }

function verzoek(url: URL, methode: 'HEAD' | 'GET', timeoutMs: number): Promise<Antwoord> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: methode,
      lookup: veiligeLookup,
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'nl-NL,nl;q=0.9' },
      timeout: timeoutMs,
    }, (res) => {
      const a: Antwoord = { status: res.statusCode ?? 0, locatie: res.headers.location };
      // Niet de hele pagina lezen
      res.destroy();
      resolve(a);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', reject);
    req.end();
  });
}

export async function controleer(doel: string, timeoutMs = 10000): Promise<{ resultaat: Resultaat; status?: number; detail?: string }> {
  let huidig = doel;
  const gezien = new Set<string>();
  for (let hop = 0; hop < 8; hop++) {
    const o = privéToestaan && /^http:\/\/127\.0\.0\.1:/.test(huidig) ? { ok: true as const, url: new URL(huidig) } : beoordeelUrl(huidig);
    if (!o.ok) return { resultaat: 'ongeldig', detail: `${o.reden} (${huidig.slice(0, 200)})` };
    if (gezien.has(huidig)) return { resultaat: 'loop', detail: huidig.slice(0, 200) };
    gezien.add(huidig);
    let a: Antwoord;
    try {
      a = await verzoek(o.url, 'HEAD', timeoutMs);
      // Veel sites blokkeren HEAD: dan met GET opnieuw
      if ([400, 403, 404, 405, 406, 429, 501, 503].includes(a.status)) a = await verzoek(o.url, 'GET', timeoutMs);
    } catch (e) {
      const code = (e as { code?: string }).code ?? '';
      if (code === 'ENOTFOUND') return { resultaat: 'dns', detail: code };
      if (code === 'PRIVE_ADRES') return { resultaat: 'ongeldig', detail: 'bestemming verwijst naar intern adres' };
      if (code === 'TIMEOUT' || code === 'ETIMEDOUT') return { resultaat: 'timeout' };
      return { resultaat: 'tijdelijk', detail: code || (e as Error).message };
    }
    if (a.status >= 300 && a.status < 400 && a.locatie) {
      huidig = new URL(a.locatie, huidig).toString();
      continue;
    }
    if (a.status >= 200 && a.status < 300) return { resultaat: 'ok', status: a.status };
    if (a.status === 404 || a.status === 410) return { resultaat: 'definitief', status: a.status };
    // 401/403/429/5xx en overige: niet als verlopen behandelen
    return { resultaat: 'tijdelijk', status: a.status };
  }
  return { resultaat: 'loop', detail: 'meer dan 8 doorverwijzingen' };
}

/** Controleert een portie links (langst niet gecontroleerd eerst) en slaat het resultaat op. */
export async function controleerPortie(pool: Pool, aantal: number, gelijktijdig = 6) {
  const { rows } = await pool.query(
    `SELECT l.id, l.doel_url FROM links l LEFT JOIN link_controles k ON k.link_id = l.id
      WHERE l.actief ORDER BY k.gecontroleerd NULLS FIRST LIMIT $1`,
    [aantal],
  );
  // Zelfde bestemming maar één keer opvragen
  const perDoel = new Map<string, string[]>();
  for (const r of rows) perDoel.set(r.doel_url, [...(perDoel.get(r.doel_url) ?? []), r.id]);
  const doelen = [...perDoel.keys()];
  const telling: Record<string, number> = {};
  let i = 0;
  async function werker() {
    while (i < doelen.length) {
      const doel = doelen[i++];
      const r = await controleer(doel);
      telling[r.resultaat] = (telling[r.resultaat] ?? 0) + 1;
      for (const id of perDoel.get(doel)!) {
        await pool.query(
          `INSERT INTO link_controles (link_id, gecontroleerd, resultaat, http_status, detail, opeenvolgend_fout, eerste_fout)
           VALUES ($1, now(), $2, $3, $4, CASE WHEN $2 = 'ok' THEN 0 ELSE 1 END, CASE WHEN $2 = 'ok' THEN NULL ELSE now() END)
           ON CONFLICT (link_id) DO UPDATE SET gecontroleerd = now(), resultaat = $2, http_status = $3, detail = $4,
             opeenvolgend_fout = CASE WHEN $2 = 'ok' THEN 0 ELSE link_controles.opeenvolgend_fout + 1 END,
             eerste_fout = CASE WHEN $2 = 'ok' THEN NULL ELSE COALESCE(link_controles.eerste_fout, now()) END`,
          [id, r.resultaat, r.status ?? null, r.detail ?? null],
        );
      }
    }
  }
  await Promise.all(Array.from({ length: gelijktijdig }, werker));
  return { gecontroleerd_links: rows.length, unieke_bestemmingen: doelen.length, telling };
}

/**
 * Ernst: 'ernstig' alleen bij herhaald definitieve fouten (404/410, DNS, ongeldig, loop)
 * na minimaal 2 opeenvolgende controles; tijdelijke fouten pas na 5 dagen achter elkaar.
 */
export async function problematischeLinks(pool: Pool, app?: string) {
  const { rows } = await pool.query(
    `SELECT l.id AS link_id, a.slug AS app, l.cms_item_id, l.pagina_titel, l.rubriek, l.label, l.doel_url,
            k.resultaat, k.http_status, k.detail, k.opeenvolgend_fout, k.eerste_fout, k.gecontroleerd,
            CASE
              WHEN k.resultaat IN ('definitief','dns','ongeldig','loop') AND k.opeenvolgend_fout >= 2 THEN 'ernstig'
              WHEN k.resultaat IN ('tijdelijk','timeout') AND k.opeenvolgend_fout >= 5 THEN 'aandacht'
              ELSE 'waarnemen'
            END AS ernst
       FROM link_controles k JOIN links l ON l.id = k.link_id JOIN apps a ON a.id = l.app_id
      WHERE k.resultaat <> 'ok' AND l.actief AND ($1::text IS NULL OR a.slug = $1)
      ORDER BY (CASE WHEN k.resultaat IN ('definitief','dns','ongeldig','loop') THEN 0 ELSE 1 END), k.opeenvolgend_fout DESC`,
    [app ?? null],
  );
  return rows;
}
