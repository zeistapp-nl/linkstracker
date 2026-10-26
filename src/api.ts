import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from './db.js';
import type { Cache } from './cache.js';
import type { KlikWachtrij } from './wachtrij.js';
import { config, normaliseerBron } from './config.js';
import { herschrijf, RewriteFout } from './rewrite.js';
import { statistieken, valideerPeriode, vorigeWeek, GROEPEN, type Groep } from './stats.js';
import { controleerPortie, problematischeLinks } from './linkcheck.js';
import { beoordeelUrl, hostVan } from './url.js';

type Recht = 'lezen' | 'schrijven' | 'beheer';
const NIVEAU: Record<Recht, number> = { lezen: 1, schrijven: 2, beheer: 3 };

export function hashSleutel(k: string): string {
  return createHash('sha256').update(k).digest('hex');
}

function gelijk(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

declare module 'fastify' {
  interface FastifyRequest { client?: { naam: string; recht: Recht } }
}

function fout(reply: FastifyReply, status: number, bericht: string, extra: Record<string, unknown> = {}) {
  return reply.code(status).send({ fout: bericht, ...extra });
}

export function registreerApi(app: FastifyInstance, pool: Pool, cache: Cache, wachtrij: KlikWachtrij) {
  const vereist = (recht: Recht) => async (req: FastifyRequest, reply: FastifyReply) => {
    const sleutel = (req.headers['x-api-key'] as string | undefined) ?? (req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '');
    if (!sleutel) return fout(reply, 401, 'API-sleutel ontbreekt (header x-api-key)');
    if (config.adminApiKey && gelijk(sleutel, config.adminApiKey)) {
      req.client = { naam: 'admin-env', recht: 'beheer' };
    } else {
      const { rows } = await pool.query(
        `UPDATE api_clients SET laatst_gebruikt = now() WHERE key_hash = $1 AND actief RETURNING naam, recht`,
        [hashSleutel(sleutel)],
      );
      if (!rows.length) return fout(reply, 401, 'Ongeldige API-sleutel');
      req.client = { naam: rows[0].naam, recht: rows[0].recht };
    }
    if (NIVEAU[req.client.recht] < NIVEAU[recht]) return fout(reply, 403, `Recht '${recht}' vereist`);
  };

  // ---------- Herschrijven ----------
  app.post('/api/rewrite', { preHandler: vereist('schrijven'), bodyLimit: 3 * 1024 * 1024 }, async (req, reply) => {
    const b = req.body as Record<string, unknown>;
    if (!b || typeof b !== 'object') return fout(reply, 400, 'JSON-body verwacht');
    try {
      const r = await herschrijf(pool, cache, {
        app: String(b.app ?? ''),
        cms_item_id: String(b.cms_item_id ?? ''),
        rubriek: typeof b.rubriek === 'string' ? b.rubriek : undefined,
        pagina_titel: typeof b.pagina_titel === 'string' ? b.pagina_titel : undefined,
        html: b.html as string,
        bron: typeof b.bron === 'string' ? b.bron : undefined,
        dry_run: b.dry_run === true,
      }, req.client!.naam);
      return r;
    } catch (e) {
      if (e instanceof RewriteFout) return fout(reply, e.status, e.message);
      throw e;
    }
  });

  // ---------- Links ----------
  app.get('/api/links', { preHandler: vereist('lezen') }, async (req) => {
    const q = req.query as Record<string, string>;
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 1000);
    const offset = Math.max(Number(q.offset) || 0, 0);
    const params: unknown[] = [];
    const waar: string[] = ['true'];
    const voeg = (sql: string, v: unknown) => { params.push(v); waar.push(sql.replace('?', `$${params.length}`)); };
    if (q.app) voeg('a.slug = ?', q.app);
    if (q.cms_item_id) voeg('l.cms_item_id = ?', q.cms_item_id);
    if (q.rubriek) voeg('l.rubriek = ?', q.rubriek);
    if (q.ondernemer_id) voeg('l.ondernemer_id = ?', Number(q.ondernemer_id));
    if (q.actief) voeg('l.actief = ?', q.actief === 'true');
    if (q.zoek) {
      params.push(q.zoek);
      const n = `$${params.length}`;
      waar.push(`(l.doel_url ILIKE '%' || ${n} || '%' OR l.label ILIKE '%' || ${n} || '%' OR l.pagina_titel ILIKE '%' || ${n} || '%')`);
    }
    const { rows } = await pool.query(
      `SELECT l.id, a.slug AS app, l.cms_item_id, l.rubriek, l.pagina_titel, l.label, l.oorspronkelijke_url, l.doel_url,
              l.ondernemer_id, l.handmatig_vast, l.actief, l.aangemaakt, l.bijgewerkt,
              'https://' || a.redirect_domein || '/r/' || l.id AS redirect_url,
              count(*) OVER()::int AS totaal_aantal
         FROM links l JOIN apps a ON a.id = l.app_id
        WHERE ${waar.join(' AND ')}
        ORDER BY l.aangemaakt DESC LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return { totaal: rows[0]?.totaal_aantal ?? 0, limit, offset, links: rows.map(({ totaal_aantal, ...r }) => r) };
  });

  app.get('/api/links/:id', { preHandler: vereist('lezen') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { rows } = await pool.query(
      `SELECT l.*, a.slug AS app FROM links l JOIN apps a ON a.id = l.app_id WHERE l.id = $1`, [id]);
    if (!rows.length) return fout(reply, 404, 'Link niet gevonden');
    const w = await pool.query(`SELECT veld, oud, nieuw, door, tijdstip FROM link_wijzigingen WHERE link_id = $1 ORDER BY tijdstip DESC LIMIT 50`, [id]);
    const c = await pool.query(`SELECT * FROM link_controles WHERE link_id = $1`, [id]);
    return { ...rows[0], wijzigingen: w.rows, controle: c.rows[0] ?? null };
  });

  app.patch('/api/links/:id', { preHandler: vereist('schrijven') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const { rows } = await db.query(`SELECT * FROM links WHERE id = $1 FOR UPDATE`, [id]);
      if (!rows.length) { await db.query('ROLLBACK'); return fout(reply, 404, 'Link niet gevonden'); }
      const oud = rows[0];
      const set: Record<string, unknown> = {};
      if (b.doel_url !== undefined) {
        const o = beoordeelUrl(String(b.doel_url));
        if (!o.ok) { await db.query('ROLLBACK'); return fout(reply, 400, `Ongeldige doel_url: ${o.reden}`); }
        if (cache.appsPerDomein.has(o.url.hostname.toLowerCase())) { await db.query('ROLLBACK'); return fout(reply, 400, 'doel_url mag niet naar een redirectdomein wijzen'); }
        set.doel_url = o.url.toString();
        // Handmatige wijziging beschermen tegen overschrijven bij een latere paginaverwerking, tenzij expliciet anders
        set.handmatig_vast = b.handmatig_vast === false ? false : true;
      } else if (typeof b.handmatig_vast === 'boolean') set.handmatig_vast = b.handmatig_vast;
      if (typeof b.actief === 'boolean') set.actief = b.actief;
      if (typeof b.label === 'string') set.label = b.label.slice(0, 160);
      if (b.ondernemer_id === null || typeof b.ondernemer_id === 'number') set.ondernemer_id = b.ondernemer_id;
      const velden = Object.keys(set);
      if (!velden.length) { await db.query('ROLLBACK'); return fout(reply, 400, 'Niets te wijzigen'); }
      await db.query(
        `UPDATE links SET ${velden.map((v, i) => `${v} = $${i + 2}`).join(', ')}, bijgewerkt = now() WHERE id = $1`,
        [id, ...velden.map((v) => set[v])],
      );
      for (const v of velden) {
        if (String(oud[v]) !== String(set[v])) {
          await db.query(`INSERT INTO link_wijzigingen (link_id, veld, oud, nieuw, door) VALUES ($1,$2,$3,$4,$5)`,
            [id, v, oud[v] === null ? null : String(oud[v]), set[v] === null ? null : String(set[v]), req.client!.naam]);
        }
      }
      const { rows: nieuw } = await db.query(`SELECT * FROM links WHERE id = $1`, [id]);
      await db.query('COMMIT');
      cache.zet({ id, appId: nieuw[0].app_id, doelUrl: nieuw[0].doel_url, actief: nieuw[0].actief });
      return nieuw[0];
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      db.release();
    }
  });

  /**
   * Voorlopige pagina-sleutel omzetten naar het echte CMS-item-id.
   * Nieuwe CMS-items krijgen pas een id na opslaan; publicatieworkflows herschrijven daarom eerst met
   * een voorlopige sleutel (bijv. "tmp:persbericht:<uuid>") en koppelen na opslaan om. Link-id's blijven gelijk.
   */
  app.post('/api/links/herkoppel', { preHandler: vereist('schrijven') }, async (req, reply) => {
    const b = (req.body ?? {}) as { app?: string; van_cms_item_id?: string; naar_cms_item_id?: string; pagina_titel?: string };
    const a = b.app ? cache.appVoorSlug(b.app) : undefined;
    const van = String(b.van_cms_item_id ?? '').trim();
    const naar = String(b.naar_cms_item_id ?? '').trim();
    if (!a || !van || !naar || naar.length > 100) return fout(reply, 400, 'app, van_cms_item_id en naar_cms_item_id verplicht');
    if (van === naar) return { verplaatst: 0 };
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${a.id}|${naar}`]);
      const { rows } = await db.query(`SELECT id, sleutel_url, volgnr FROM links WHERE app_id = $1 AND cms_item_id = $2 FOR UPDATE`, [a.id, van]);
      let n = 0;
      for (const l of rows) {
        // Bestaat dezelfde bestemming al op het doel-item, dan krijgt deze link het volgende volgnummer
        const { rows: [{ max }] } = await db.query(
          `SELECT COALESCE(max(volgnr), 0)::int AS max FROM links WHERE app_id = $1 AND cms_item_id = $2 AND sleutel_url = $3`, [a.id, naar, l.sleutel_url]);
        const botst = (await db.query(`SELECT 1 FROM links WHERE app_id = $1 AND cms_item_id = $2 AND sleutel_url = $3 AND volgnr = $4`, [a.id, naar, l.sleutel_url, l.volgnr])).rowCount;
        await db.query(
          `UPDATE links SET cms_item_id = $2, volgnr = $3, pagina_titel = COALESCE($4, pagina_titel), bijgewerkt = now() WHERE id = $1`,
          [l.id, naar, botst ? max + 1 : l.volgnr, b.pagina_titel ?? null]);
        await db.query(`INSERT INTO link_wijzigingen (link_id, veld, oud, nieuw, door) VALUES ($1,'cms_item_id',$2,$3,$4)`, [l.id, van, naar, req.client!.naam]);
        n++;
      }
      await db.query('COMMIT');
      return { verplaatst: n };
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      db.release();
    }
  });

  // ---------- Statistieken ----------
  const periodeUit = (q: Record<string, string>) => {
    if (q.periode === 'vorige_week') { const w = vorigeWeek(); return { van: w.van, tot: w.tot }; }
    return valideerPeriode(q.van, q.tot);
  };

  app.get('/api/stats', { preHandler: vereist('lezen') }, async (req, reply) => {
    const q = req.query as Record<string, string>;
    let p;
    try { p = periodeUit(q); } catch (e) { return fout(reply, 400, (e as Error).message); }
    const groepen = (q.groep ?? 'app').split(',').map((s) => s.trim()).filter(Boolean) as Groep[];
    const ongeldig = groepen.filter((g) => !(g in GROEPEN));
    if (ongeldig.length) return fout(reply, 400, `Onbekende groep: ${ongeldig.join(',')}. Kies uit ${Object.keys(GROEPEN).join(', ')}`);
    const rijen = await statistieken(pool, { ...p, app: q.app, bron: q.bron, groepen, limit: Number(q.limit) || undefined,
      ondernemerId: q.ondernemer_id ? Number(q.ondernemer_id) : undefined });
    return { periode: p, groepen, tijdzone: 'Europe/Amsterdam', toelichting: UITLEG, rijen };
  });

  app.get('/api/stats/daily', { preHandler: vereist('lezen') }, async (req, reply) => {
    const q = req.query as Record<string, string>;
    let p;
    try { p = periodeUit(q); } catch (e) { return fout(reply, 400, (e as Error).message); }
    const rijen = await statistieken(pool, { ...p, app: q.app, groepen: ['dag', 'app', 'link', 'bron'], limit: 50000 });
    rijen.sort((a, b) => (a.dag < b.dag ? -1 : a.dag > b.dag ? 1 : b.geldig - a.geldig));
    return { periode: p, tijdzone: 'Europe/Amsterdam', toelichting: UITLEG, rijen };
  });

  /** Kant-en-klare weekrapportage voor n8n: totalen, vorige week, rubrieken, bronnen, toppagina's, detail, ondernemers. */
  app.get('/api/rapport/week', { preHandler: vereist('lezen') }, async (req, reply) => {
    const q = req.query as Record<string, string>;
    let p;
    try { p = q.van ? valideerPeriode(q.van, q.tot) : vorigeWeek(); } catch (e) { return fout(reply, 400, (e as Error).message); }
    const van = new Date(`${p.van}T00:00:00Z`);
    const dagen = Math.round((new Date(`${p.tot}T00:00:00Z`).getTime() - van.getTime()) / 86400000) + 1;
    const f = (d: Date) => d.toISOString().slice(0, 10);
    const vorige = { van: f(new Date(van.getTime() - dagen * 86400000)), tot: f(new Date(van.getTime() - 86400000)) };
    const s = (groepen: Groep[], pp = p, limit?: number) => statistieken(pool, { van: pp.van, tot: pp.tot, groepen, limit });
    const [perApp, perAppVorige, rubriek, bron, paginas, detail, ondernemers, controle] = await Promise.all([
      s(['app']), s(['app'], vorige), s(['app', 'rubriek']), s(['app', 'bron']), s(['app', 'pagina'], p, 25),
      s(['dag', 'app', 'link', 'bron'], p, 50000), s(['app', 'ondernemer']),
      pool.query(`SELECT sleutel, sum(waarde)::bigint AS waarde FROM metriek_dag WHERE dag BETWEEN $1 AND $2 GROUP BY sleutel`, [p.van, p.tot]),
    ]);
    const m = Object.fromEntries(controle.rows.map((r) => [r.sleutel, Number(r.waarde)]));
    const inDb = await pool.query(
      `SELECT count(*)::int AS n FROM clicks WHERE ts >= ($1::date)::timestamp AT TIME ZONE 'Europe/Amsterdam'
         AND ts < (($2::date) + 1)::timestamp AT TIME ZONE 'Europe/Amsterdam'`, [p.van, p.tot]);
    return {
      periode: p, vorige_periode: vorige, week: (p as { week?: string }).week, tijdzone: 'Europe/Amsterdam', toelichting: UITLEG,
      per_app: perApp, per_app_vorige: perAppVorige, per_rubriek: rubriek, per_bron: bron, top_paginas: paginas,
      detail, ondernemers,
      integriteit: {
        ontvangen: m.ontvangen ?? 0, opgeslagen: m.opgeslagen ?? 0, verworpen: m.verworpen ?? 0,
        in_database: inDb.rows[0].n,
        compleet: (m.verworpen ?? 0) === 0,
      },
    };
  });

  app.get('/api/stats/ondernemers', { preHandler: vereist('lezen') }, async (req, reply) => {
    const q = req.query as Record<string, string>;
    let p;
    try { p = periodeUit(q); } catch (e) { return fout(reply, 400, (e as Error).message); }
    return { periode: p, rijen: await statistieken(pool, { ...p, app: q.app, groepen: ['app', 'ondernemer'] }) };
  });

  // ---------- Ondernemers ----------
  app.get('/api/ondernemers', { preHandler: vereist('lezen') }, async (req) => {
    const q = req.query as Record<string, string>;
    const { rows } = await pool.query(
      `SELECT o.id, a.slug AS app, o.naam, o.extern_id, o.actief,
              COALESCE(json_agg(json_build_object('type', k.type, 'waarde', k.waarde)) FILTER (WHERE k.id IS NOT NULL), '[]') AS koppelingen,
              (SELECT count(*)::int FROM links l WHERE l.ondernemer_id = o.id) AS links
         FROM ondernemers o JOIN apps a ON a.id = o.app_id LEFT JOIN ondernemer_koppelingen k ON k.ondernemer_id = o.id
        WHERE ($1::text IS NULL OR a.slug = $1) GROUP BY o.id, a.slug ORDER BY o.naam`, [q.app ?? null]);
    return { ondernemers: rows };
  });

  /** Ondernemer aanmaken of bijwerken, met koppelingen (host en/of cms_item). Koppelt bestaande links direct. */
  app.post('/api/ondernemers', { preHandler: vereist('schrijven') }, async (req, reply) => {
    const b = (req.body ?? {}) as { app?: string; naam?: string; extern_id?: string; hosts?: string[]; cms_items?: string[] };
    const a = b.app ? cache.appVoorSlug(b.app) : undefined;
    if (!a || !b.naam) return fout(reply, 400, 'app en naam verplicht');
    const hosts = (b.hosts ?? []).map((h) => h.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '')).filter(Boolean);
    const items = (b.cms_items ?? []).map((s) => String(s).trim()).filter(Boolean);
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const { rows } = await db.query(
        `INSERT INTO ondernemers (app_id, naam, extern_id) VALUES ($1,$2,$3)
         ON CONFLICT (app_id, naam) DO UPDATE SET extern_id = COALESCE(EXCLUDED.extern_id, ondernemers.extern_id), actief = true RETURNING id`,
        [a.id, b.naam.trim(), b.extern_id ?? null]);
      const oid = rows[0].id;
      for (const h of hosts) await db.query(`INSERT INTO ondernemer_koppelingen (ondernemer_id, type, waarde) VALUES ($1,'host',$2) ON CONFLICT DO NOTHING`, [oid, h]);
      for (const i of items) await db.query(`INSERT INTO ondernemer_koppelingen (ondernemer_id, type, waarde) VALUES ($1,'cms_item',$2) ON CONFLICT DO NOTHING`, [oid, i]);
      const gekoppeld = await herkoppel(db, a.id, oid);
      await db.query('COMMIT');
      return { id: oid, gekoppelde_links: gekoppeld };
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      db.release();
    }
  });

  // ---------- Dode links ----------
  app.get('/api/broken-links', { preHandler: vereist('lezen') }, async (req) => {
    const q = req.query as Record<string, string>;
    const rijen = await problematischeLinks(pool, q.app);
    return { aantal: rijen.length, ernstig: rijen.filter((r) => r.ernst === 'ernstig').length, rijen };
  });

  app.post('/api/broken-links/check', { preHandler: vereist('schrijven') }, async (req) => {
    const b = (req.body ?? {}) as { aantal?: number };
    return controleerPortie(pool, Math.min(Math.max(Number(b.aantal) || 200, 1), 1000));
  });

  // ---------- Export (back-up van alle originele URL's) ----------
  app.get('/api/export/links', { preHandler: vereist('lezen') }, async (_req, reply) => {
    const { rows } = await pool.query(
      `SELECT l.id, a.slug AS app, a.redirect_domein, l.cms_item_id, l.rubriek, l.pagina_titel, l.label, l.oorspronkelijke_url, l.doel_url, l.actief, l.aangemaakt
         FROM links l JOIN apps a ON a.id = l.app_id ORDER BY a.slug, l.cms_item_id, l.id`);
    const kol = ['id', 'app', 'redirect_url', 'cms_item_id', 'rubriek', 'pagina_titel', 'label', 'oorspronkelijke_url', 'doel_url', 'actief', 'aangemaakt'];
    const esc = (v: unknown) => { const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [kol.join(','), ...rows.map((r) => kol.map((k) => esc(k === 'redirect_url' ? `https://${r.redirect_domein}/r/${r.id}` : r[k])).join(','))].join('\n');
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="links-export.csv"');
    return csv;
  });

  // ---------- Status (monitoring) ----------
  app.get('/api/status', { preHandler: vereist('lezen') }, async () => {
    const metriek = await pool.query(`SELECT dag, sleutel, waarde FROM metriek_dag WHERE dag >= current_date - 7 ORDER BY dag DESC, sleutel`);
    const fouten = await pool.query(`SELECT soort, detail, tijdstip FROM fouten WHERE tijdstip > now() - interval '7 days' ORDER BY tijdstip DESC LIMIT 50`);
    const apps = await pool.query(`SELECT slug, naam, redirect_domein, rewrite_modus, actief FROM apps ORDER BY id`);
    const tellingen = await pool.query(`SELECT (SELECT count(*) FROM links)::int AS links, (SELECT count(*) FROM clicks)::int AS kliks`);
    return {
      wachtrij: { diepte: wachtrij.diepte, max_diepte: wachtrij.maxDiepte, tellers: wachtrij.tellers, laatste_flush_ok: wachtrij.laatsteFlushOk, laatste_fout: wachtrij.laatsteFout },
      cache: { links: cache.grootte, db_ok: cache.dbOk },
      apps: apps.rows, ...tellingen.rows[0], metriek: metriek.rows, fouten: fouten.rows,
    };
  });

  // ---------- Beheer ----------
  app.post('/api/clients', { preHandler: vereist('beheer') }, async (req, reply) => {
    const b = (req.body ?? {}) as { naam?: string; recht?: Recht };
    if (!b.naam || !b.recht || !(b.recht in NIVEAU)) return fout(reply, 400, 'naam en recht (lezen|schrijven|beheer) verplicht');
    const sleutel = `lt_${randomBytes(24).toString('base64url')}`;
    await pool.query(
      `INSERT INTO api_clients (naam, key_hash, recht) VALUES ($1,$2,$3)
       ON CONFLICT (naam) DO UPDATE SET key_hash = EXCLUDED.key_hash, recht = EXCLUDED.recht, actief = true`,
      [b.naam, hashSleutel(sleutel), b.recht]);
    // Sleutel wordt alleen nu getoond; in de database staat alleen de hash
    return { naam: b.naam, recht: b.recht, api_key: sleutel };
  });

  app.delete('/api/clients/:naam', { preHandler: vereist('beheer') }, async (req) => {
    const { rowCount } = await pool.query(`UPDATE api_clients SET actief = false WHERE naam = $1`, [(req.params as { naam: string }).naam]);
    return { ingetrokken: rowCount === 1 };
  });

  app.get('/api/apps', { preHandler: vereist('lezen') }, async () => {
    const { rows } = await pool.query(`SELECT slug, naam, redirect_domein, fallback_url, utm_source, rewrite_modus, actief FROM apps ORDER BY id`);
    return { apps: rows };
  });

  /** Nieuwe lokale app toevoegen of instellingen wijzigen (bijv. rewrite_modus van dry_run naar aan). */
  app.put('/api/apps/:slug', { preHandler: vereist('beheer') }, async (req, reply) => {
    const slug = (req.params as { slug: string }).slug;
    const b = (req.body ?? {}) as Record<string, string | boolean>;
    if (!/^[a-z0-9-]{2,40}$/.test(slug)) return fout(reply, 400, 'Ongeldige slug');
    const bestaand = cache.appVoorSlug(slug);
    const naam = (b.naam as string) ?? bestaand?.naam;
    const domein = ((b.redirect_domein as string) ?? bestaand?.domein)?.toLowerCase();
    const fallback = (b.fallback_url as string) ?? bestaand?.fallbackUrl;
    const utm = (b.utm_source as string) ?? bestaand?.utmSource;
    const modus = (b.rewrite_modus as string) ?? bestaand?.rewriteModus ?? 'dry_run';
    const actief = typeof b.actief === 'boolean' ? b.actief : bestaand?.actief ?? true;
    if (!naam || !domein || !fallback || !utm) return fout(reply, 400, 'naam, redirect_domein, fallback_url en utm_source verplicht voor een nieuwe app');
    if (!beoordeelUrl(fallback).ok) return fout(reply, 400, 'Ongeldige fallback_url');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domein)) return fout(reply, 400, 'Ongeldig redirect_domein');
    if (!['uit', 'dry_run', 'aan'].includes(modus)) return fout(reply, 400, 'rewrite_modus: uit | dry_run | aan');
    await pool.query(
      `INSERT INTO apps (slug, naam, redirect_domein, fallback_url, utm_source, rewrite_modus, actief) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (slug) DO UPDATE SET naam=$2, redirect_domein=$3, fallback_url=$4, utm_source=$5, rewrite_modus=$6, actief=$7`,
      [slug, naam, domein, fallback, utm, modus, actief]);
    await cache.laadApps();
    return cache.appVoorSlug(slug);
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) {
      console.error(JSON.stringify({ niveau: 'fout', soort: 'api', pad: req.url, bericht: err.message }));
      pool.query('INSERT INTO fouten (soort, detail) VALUES ($1,$2)', ['api', { pad: req.routeOptions?.url, bericht: err.message }]).catch(() => {});
    }
    reply.code(status).send({ fout: status >= 500 ? 'Interne fout' : err.message });
  });
}

/** Koppelt links aan een ondernemer op basis van zijn koppelregels (alleen links zonder ondernemer). */
async function herkoppel(db: import('pg').PoolClient, appId: number, ondernemerId: number): Promise<number> {
  const { rows } = await db.query(`SELECT type, waarde FROM ondernemer_koppelingen WHERE ondernemer_id = $1`, [ondernemerId]);
  let n = 0;
  for (const k of rows) {
    if (k.type === 'cms_item') {
      n += (await db.query(`UPDATE links SET ondernemer_id = $1 WHERE app_id = $2 AND cms_item_id = $3 AND ondernemer_id IS NULL`, [ondernemerId, appId, k.waarde])).rowCount ?? 0;
    } else {
      const { rows: kandidaten } = await db.query(`SELECT id, doel_url FROM links WHERE app_id = $1 AND ondernemer_id IS NULL`, [appId]);
      for (const l of kandidaten) {
        try {
          if (hostVan(new URL(l.doel_url)) === k.waarde) {
            await db.query(`UPDATE links SET ondernemer_id = $1 WHERE id = $2`, [ondernemerId, l.id]);
            n++;
          }
        } catch { /* ongeldige URL negeren */ }
      }
    }
  }
  return n;
}

const UITLEG = {
  totaal: 'Alle ontvangen GET-verzoeken op een trackinglink (inclusief bots en dubbele kliks).',
  bots: 'Verzoeken van herkende bots, linkpreviews en mailscanners.',
  dubbel: 'Herhaalde klik op dezelfde link door dezelfde (gepseudonimiseerde) bezoeker binnen 30 seconden.',
  niet_doorgestuurd: 'Kliks op inactieve links of via het domein van een andere app.',
  geldig: 'Menselijke kliks, zonder dubbele kliks, die naar de bestemming zijn doorgestuurd.',
  geschat_uniek: 'Benadering: aantal verschillende bezoekers per dag, opgeteld over de periode. Geen exacte telling van personen.',
};

export { normaliseerBron };
