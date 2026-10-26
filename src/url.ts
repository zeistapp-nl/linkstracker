import { isIP } from 'node:net';

export type UrlOordeel =
  | { ok: true; url: URL }
  | { ok: false; reden: string };

const MAX_LENGTE = 2048;

/** Is dit IP-adres privé, loopback, link-local of anderszins niet publiek? */
export function isPriveIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number);
    return (
      p[0] === 0 || p[0] === 10 || p[0] === 127 ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 192 && p[1] === 0 && p[2] === 0) ||
      (p[0] === 198 && (p[1] === 18 || p[1] === 19)) ||
      p[0] >= 224
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    if (s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') || s.startsWith('fe9') ||
        s.startsWith('fea') || s.startsWith('feb') || s.startsWith('ff')) return true;
    const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPriveIp(m[1]);
    return false;
  }
  return false;
}

/** Controleert of een href een geschikte, veilige externe http(s)-bestemming is. */
export function beoordeelUrl(href: string): UrlOordeel {
  const ruw = href.trim();
  if (ruw.length === 0) return { ok: false, reden: 'leeg' };
  if (ruw.length > MAX_LENGTE) return { ok: false, reden: 'te_lang' };
  if (/[\u0000-\u001f\u007f]/.test(ruw)) return { ok: false, reden: 'stuurtekens' };
  let u: URL;
  try {
    u = new URL(ruw);
  } catch {
    return { ok: false, reden: 'geen_absolute_url' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reden: `protocol_${u.protocol.replace(':', '')}` };
  if (u.username || u.password) return { ok: false, reden: 'inloggegevens_in_url' };
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, reden: 'geen_host' };
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') ||
      host.endsWith('.lan') || host.endsWith('.home.arpa')) {
    return { ok: false, reden: 'interne_host' };
  }
  if (isIP(host)) {
    if (isPriveIp(host)) return { ok: false, reden: 'prive_ip' };
  } else if (!host.includes('.')) {
    return { ok: false, reden: 'host_zonder_domein' };
  }
  if (u.port && !['80', '443', '8080', '8443'].includes(u.port)) return { ok: false, reden: 'ongebruikelijke_poort' };
  return { ok: true, url: u };
}

export function hostVan(u: URL): string {
  return u.hostname.toLowerCase().replace(/^www\./, '');
}

/**
 * Sleutel-URL: bepaalt of twee links dezelfde bestemming hebben.
 * Zonder utm_*, fragment, standaardpoort; host in kleine letters; queryparameters gesorteerd.
 */
export function sleutelUrl(u: URL): string {
  const k = new URL(u.toString());
  k.hash = '';
  k.hostname = k.hostname.toLowerCase();
  if ((k.protocol === 'https:' && k.port === '443') || (k.protocol === 'http:' && k.port === '80')) k.port = '';
  const params = [...k.searchParams.entries()].filter(([n]) => !n.toLowerCase().startsWith('utm_'));
  params.sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  k.search = '';
  for (const [n, v] of params) k.searchParams.append(n, v);
  let s = k.toString();
  // https en http naar dezelfde plek = dezelfde bestemming
  s = s.replace(/^http:\/\//, 'https://');
  if (k.pathname === '/' && !k.search) s = s.replace(/\/$/, '');
  return s;
}

/**
 * Voegt UTM toe als de link er nog geen heeft en de host niet is uitgezonderd.
 * Bestaande UTM's blijven ongemoeid: de redactie heeft ze bewust gezet.
 */
export function metUtm(u: URL, opties: { source: string; medium: string; campaign?: string; uitzonderingen: string[] }): { url: string; toegevoegd: boolean } {
  const heeftUtm = [...u.searchParams.keys()].some((n) => n.toLowerCase().startsWith('utm_'));
  const host = hostVan(u);
  const uitgezonderd = opties.uitzonderingen.some((h) => host === h || host.endsWith('.' + h));
  if (heeftUtm || uitgezonderd) return { url: u.toString(), toegevoegd: false };
  const n = new URL(u.toString());
  n.searchParams.set('utm_source', opties.source);
  n.searchParams.set('utm_medium', opties.medium);
  if (opties.campaign) n.searchParams.set('utm_campaign', opties.campaign);
  return { url: n.toString(), toegevoegd: true };
}

export function slugCampagne(rubriek: string | undefined | null): string | undefined {
  if (!rubriek) return undefined;
  const s = rubriek
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, 'en').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return s || undefined;
}
