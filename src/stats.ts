import type { Pool } from './db.js';

export const GROEPEN = {
  app: { sel: `a.slug AS app`, grp: `a.slug` },
  dag: { sel: `to_char((c.ts AT TIME ZONE 'Europe/Amsterdam')::date, 'YYYY-MM-DD') AS dag`, grp: `1` },
  rubriek: { sel: `COALESCE(l.rubriek, '(onbekend)') AS rubriek`, grp: `COALESCE(l.rubriek, '(onbekend)')` },
  pagina: { sel: `l.cms_item_id, max(l.pagina_titel) AS pagina_titel`, grp: `l.cms_item_id` },
  link: { sel: `l.id AS link_id, max(l.label) AS label, max(l.doel_url) AS bestemming, max(l.cms_item_id) AS cms_item_id, max(l.pagina_titel) AS pagina_titel, max(l.rubriek) AS rubriek`, grp: `l.id` },
  bron: { sel: `c.bron`, grp: `c.bron` },
  ondernemer: { sel: `o.id AS ondernemer_id, max(o.naam) AS ondernemer`, grp: `o.id` },
} as const;
export type Groep = keyof typeof GROEPEN;

const MATEN = `
  count(*)::int AS totaal,
  count(*) FILTER (WHERE c.is_bot)::int AS bots,
  count(*) FILTER (WHERE c.is_dubbel)::int AS dubbel,
  count(*) FILTER (WHERE c.classificatie IN ('inactief','domein_mismatch'))::int AS niet_doorgestuurd,
  count(*) FILTER (WHERE NOT c.is_bot AND NOT c.is_dubbel AND c.classificatie IN ('mens','neutrale_host'))::int AS geldig,
  count(DISTINCT ((c.ts AT TIME ZONE 'Europe/Amsterdam')::date, c.ip_hash))
    FILTER (WHERE NOT c.is_bot AND c.classificatie IN ('mens','neutrale_host'))::int AS geschat_uniek`;

export interface StatsVraag {
  app?: string;
  van: string; // JJJJ-MM-DD, Amsterdamse kalenderdag, inclusief
  tot: string; // inclusief
  groepen: Groep[];
  bron?: string;
  ondernemerId?: number;
  limit?: number;
}

const DATUM = /^\d{4}-\d{2}-\d{2}$/;

export function valideerPeriode(van: unknown, tot: unknown): { van: string; tot: string } {
  if (typeof van !== 'string' || typeof tot !== 'string' || !DATUM.test(van) || !DATUM.test(tot)) {
    throw Object.assign(new Error('van en tot verplicht als JJJJ-MM-DD'), { status: 400 });
  }
  if (van > tot) throw Object.assign(new Error('van ligt na tot'), { status: 400 });
  return { van, tot };
}

export async function statistieken(pool: Pool, v: StatsVraag) {
  const params: unknown[] = [v.van, v.tot];
  const waar: string[] = [
    `c.ts >= ($1::date)::timestamp AT TIME ZONE 'Europe/Amsterdam'`,
    `c.ts < (($2::date) + 1)::timestamp AT TIME ZONE 'Europe/Amsterdam'`,
  ];
  if (v.app) { params.push(v.app); waar.push(`a.slug = $${params.length}`); }
  if (v.bron) { params.push(v.bron); waar.push(`c.bron = $${params.length}`); }
  if (v.ondernemerId) { params.push(v.ondernemerId); waar.push(`l.ondernemer_id = $${params.length}`); }
  if (v.groepen.includes('ondernemer')) waar.push(`o.id IS NOT NULL`);
  const sel = v.groepen.map((g) => GROEPEN[g].sel);
  const grp = v.groepen.map((g) => (GROEPEN[g].grp === '1' ? `(c.ts AT TIME ZONE 'Europe/Amsterdam')::date` : GROEPEN[g].grp));
  const limit = Math.min(Math.max(v.limit ?? 5000, 1), 50000);
  const sql = `
    SELECT ${[...sel, MATEN].join(',\n')}
      FROM clicks c
      JOIN links l ON l.id = c.link_id
      JOIN apps a ON a.id = l.app_id
      LEFT JOIN ondernemers o ON o.id = l.ondernemer_id
     WHERE ${waar.join(' AND ')}
     ${grp.length ? `GROUP BY ${grp.join(', ')}` : ''}
     ORDER BY ${grp.length ? 'geldig DESC, totaal DESC' : '1'}
     LIMIT ${limit}`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

/** Vorige ISO-kalenderweek (maandag t/m zondag) in Nederlandse tijd. */
export function vorigeWeek(nu = new Date()): { van: string; tot: string; week: string } {
  const dag = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(nu);
  const d = new Date(`${dag}T00:00:00Z`);
  const wd = (d.getUTCDay() + 6) % 7; // maandag = 0
  const maandag = new Date(d.getTime() - (wd + 7) * 86400000);
  const zondag = new Date(maandag.getTime() + 6 * 86400000);
  const f = (x: Date) => x.toISOString().slice(0, 10);
  return { van: f(maandag), tot: f(zondag), week: isoWeek(maandag) };
}

export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dagNr = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dagNr + 3);
  const jaar = t.getUTCFullYear();
  const eersteDonderdag = new Date(Date.UTC(jaar, 0, 4));
  const w = 1 + Math.round(((t.getTime() - eersteDonderdag.getTime()) / 86400000 - 3 + ((eersteDonderdag.getUTCDay() + 6) % 7)) / 7);
  return `${jaar}-W${String(w).padStart(2, '0')}`;
}
