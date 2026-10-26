function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Ongeldige waarde voor ${name}`);
  return n;
}

function list(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const config = {
  port: num('PORT', 8080),
  databaseUrl: process.env.DATABASE_URL ?? '',
  // Eerste beheersleutel; daarna sleutels beheren via /api/clients
  adminApiKey: process.env.ADMIN_API_KEY ?? '',
  retentieDagen: num('RETENTIE_DAGEN', 395),
  dubbelVensterMs: num('DUBBEL_VENSTER_SEC', 30) * 1000,
  wachtrijMax: num('WACHTRIJ_MAX', 20000),
  batchGrootte: num('BATCH_GROOTTE', 500),
  flushIntervalMs: num('FLUSH_INTERVAL_MS', 1000),
  cacheTtlMs: num('CACHE_TTL_SEC', 300) * 1000,
  // Extra user-agent fragmenten die als bot tellen (komma-gescheiden)
  extraBotPatronen: list('EXTRA_BOT_PATRONEN'),
  // Hosts waar nooit UTM aan wordt toegevoegd (bijv. boekingsmodules die stuk gaan op onbekende parameters)
  utmUitzonderingen: list('UTM_UITZONDERINGEN'),
  // Hosts die nooit herschreven worden (interne appnavigatie, CMS)
  nietHerschrijven: list('NIET_HERSCHRIJVEN'),
  rateLimitRedirect: num('RATE_LIMIT_REDIRECT_PER_MIN', 300),
  rateLimitApi: num('RATE_LIMIT_API_PER_MIN', 600),
};

export const BRONNEN = ['app', 'nieuwsbrief', 'social', 'campagne', 'web'] as const;
export type Bron = (typeof BRONNEN)[number];

export function normaliseerBron(b: unknown): Bron | 'onbekend' {
  if (typeof b !== 'string' || b === '') return 'app';
  const k = b.toLowerCase() as Bron;
  return (BRONNEN as readonly string[]).includes(k) ? k : 'onbekend';
}
