import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Cache } from './cache.js';
import type { KlikWachtrij } from './wachtrij.js';
import { normaliseerBron } from './config.js';

const ID = /^[A-Za-z0-9]{8}$/;

function hostZonderPoort(req: FastifyRequest): string {
  return (req.headers.host ?? '').trim().toLowerCase().replace(/:\d+$/, '');
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * De links staan in app-pagina's (in-app webview), niet op een website. Bij een onbekende,
 * uitgeschakelde of verkeerd gebruikte link sturen we de gebruiker daarom niet naar een website,
 * maar tonen we een eenvoudige pagina met de boodschap om terug te gaan naar de app.
 */
function geenBestemming(reply: FastifyReply, appNaam: string | undefined, status = 404) {
  const naam = esc(appNaam ?? 'de app');
  reply.code(status).header('Content-Type', 'text/html; charset=utf-8');
  return reply.send(`<!doctype html><html lang="nl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Link niet beschikbaar</title>
<style>body{margin:0;font-family:Nunito,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#fff8f2;color:#303030;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
main{max-width:420px;text-align:center}h1{font-size:22px;margin:0 0 12px}p{font-size:15px;line-height:1.5;margin:0}</style></head>
<body><main><h1>Deze link is niet meer beschikbaar</h1><p>Ga terug naar ${naam} om verder te kijken.</p></main></body></html>`);
}

export function registreerRedirect(app: FastifyInstance, cache: Cache, wachtrij: KlikWachtrij) {
  app.route({
    method: ['GET', 'HEAD'],
    url: '/r/:id',
    config: { rateLimit: { groupId: 'redirect' } } as never,
    handler: async (req, reply) => {
      reply.header('Cache-Control', 'no-store, max-age=0');
      reply.header('Referrer-Policy', 'no-referrer-when-downgrade');
      reply.header('X-Robots-Tag', 'noindex, nofollow');
      const id = (req.params as { id: string }).id;
      const hostApp = cache.appsPerDomein.get(hostZonderPoort(req));

      if (!ID.test(id)) {
        wachtrij.tellers.onbekend_id++;
        return geenBestemming(reply, hostApp?.naam);
      }

      let link;
      try {
        link = await cache.zoek(id);
      } catch {
        // Database onbereikbaar en link niet in cache: direct antwoorden, gebruiker niet laten hangen
        return geenBestemming(reply, hostApp?.naam, 503);
      }
      if (!link) {
        wachtrij.tellers.onbekend_id++;
        return geenBestemming(reply, hostApp?.naam);
      }

      const linkApp = cache.apps.get(link.appId);
      let doel: string | null = link.doelUrl;
      let classificatie: 'normaal' | 'inactief' | 'domein_mismatch' | 'neutrale_host' = 'normaal';

      if (!link.actief) {
        classificatie = 'inactief';
        doel = null;
      } else if (hostApp && hostApp.id !== link.appId) {
        // Link van app A via domein van app B: niet doorsturen
        classificatie = 'domein_mismatch';
        doel = null;
      } else if (!hostApp) {
        // Bijv. het *.up.railway.app-adres vóór DNS: doorsturen, maar herkenbaar registreren
        classificatie = 'neutrale_host';
      }

      // Redirectlus voorkomen: bestemming mag nooit naar een eigen redirectdomein wijzen
      if (doel) {
        try {
          if (cache.appsPerDomein.has(new URL(doel).hostname.toLowerCase())) { doel = null; classificatie = 'inactief'; }
        } catch {
          doel = null;
          classificatie = 'inactief';
        }
      }

      if (req.method === 'HEAD') {
        wachtrij.tellers.head++;
      } else {
        wachtrij.plaats({
          linkId: link.id,
          appId: link.appId,
          ts: new Date(),
          ip: req.ip,
          ua: req.headers['user-agent'],
          bron: normaliseerBron((req.query as { b?: string }).b),
          classificatie,
        });
      }
      if (!doel) return geenBestemming(reply, (hostApp ?? linkApp)?.naam, 410);
      return reply.redirect(doel, 302);
    },
  });
}
