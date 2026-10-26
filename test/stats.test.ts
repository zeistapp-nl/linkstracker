import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { nieuweOmgeving, rewrite, zetModus, H } from './helpers.js';
import { vorigeWeek, isoWeek } from '../src/stats.js';
import { beoordeelUa } from '../src/bots.js';

let o: Awaited<ReturnType<typeof nieuweOmgeving>>;
let a: string;
let b: string;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36';

before(async () => {
  o = await nieuweOmgeving();
  await zetModus(o, 'zeist', 'aan');
  const r = await rewrite(o, { app: 'zeist', cms_item_id: '100', rubriek: 'Horeca & Verblijf', pagina_titel: 'Restaurant X', html: `<a href="https://x.nl">Site</a><a href="https://x.nl/menu">Menu</a>` });
  [a, b] = r.json.links.map((l: { id: string }) => l.id);
});
after(async () => o.opruimen());

function klik(linkId: string, iso: string, ip = '203.0.113.1', ua = IPHONE, bron = 'app') {
  o.wachtrij.plaats({ linkId, appId: 1, ts: new Date(iso), ip, ua, bron, classificatie: 'normaal' });
}
async function flush() {
  for (let i = 0; i < 100 && o.wachtrij.diepte; i++) await o.wachtrij.flush(true);
}
async function stats(q: string) {
  const r = await o.app.inject({ method: 'GET', url: `/api/stats?${q}`, headers: H });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().rijen;
}

test('botherkenning', () => {
  for (const ua of ['WhatsApp/2.23.20.0', 'facebookexternalhit/1.1', 'Slackbot-LinkExpanding 1.0', 'Mozilla/5.0 (compatible; Googlebot/2.1)',
    'Mimecast Safe Links', 'Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0)', 'curl/8.4', '', 'python-requests/2.31']) {
    assert.equal(beoordeelUa(ua).isBot, true, ua);
  }
  assert.deepEqual(beoordeelUa(IPHONE), { isBot: false, klasse: 'ios_webview' });
  assert.deepEqual(beoordeelUa(ANDROID), { isBot: false, klasse: 'android_webview' });
});

test('gewone klik, dubbele klik binnen 30 s, bot, nieuwsbrief en social', async () => {
  klik(a, '2026-10-20T10:00:00Z');
  klik(a, '2026-10-20T10:00:20Z');                              // dubbel (20 s)
  klik(a, '2026-10-20T10:00:45Z');                              // > 30 s na eerste geldige: weer geldig
  klik(a, '2026-10-20T10:00:05Z', '203.0.113.2');               // andere bezoeker
  klik(a, '2026-10-20T10:01:00Z', '198.51.100.9', 'WhatsApp/2.23'); // bot
  klik(b, '2026-10-20T11:00:00Z', '203.0.113.3', ANDROID, 'nieuwsbrief');
  klik(b, '2026-10-20T12:00:00Z', '203.0.113.4', IPHONE, 'social');
  await flush();
  const rijen = await stats('van=2026-10-20&tot=2026-10-20&groep=link');
  const ra = rijen.find((r: { link_id: string }) => r.link_id === a);
  assert.equal(ra.totaal, 5);
  assert.equal(ra.bots, 1);
  assert.equal(ra.dubbel, 1);
  assert.equal(ra.geldig, 3);
  assert.equal(ra.geschat_uniek, 2);
  const perBron = await stats('van=2026-10-20&tot=2026-10-20&groep=bron');
  const bron = Object.fromEntries(perBron.map((r: { bron: string; geldig: number }) => [r.bron, r.geldig]));
  assert.deepEqual(bron, { app: 3, nieuwsbrief: 1, social: 1 });
  const rubriek = await stats('van=2026-10-20&tot=2026-10-20&groep=app,rubriek');
  assert.equal(rubriek[0].rubriek, 'Horeca & Verblijf');
  assert.equal(rubriek[0].geldig, 5);
});

test('datumgrens volgt Nederlandse tijd (wintertijd)', async () => {
  klik(a, '2026-11-02T22:59:59Z', '203.0.113.10'); // 23:59:59 op 2 nov (CET)
  klik(a, '2026-11-02T23:00:00Z', '203.0.113.11'); // 00:00 op 3 nov
  await flush();
  const r = await stats('van=2026-11-02&tot=2026-11-03&groep=dag');
  assert.deepEqual(r.map((x: { dag: string; totaal: number }) => [x.dag, x.totaal]).sort(), [['2026-11-02', 1], ['2026-11-03', 1]]);
});

test('weekgrens rond overgang zomer- naar wintertijd (25 okt 2026)', async () => {
  klik(b, '2026-10-25T22:59:00Z', '203.0.113.20'); // zondag 25 okt 23:59 CET: week 43
  klik(b, '2026-10-25T23:01:00Z', '203.0.113.21'); // maandag 26 okt 00:01 CET: week 44
  klik(b, '2026-10-25T00:30:00Z', '203.0.113.22'); // zondag 02:30 CEST (vóór de klok terug): week 43
  await flush();
  const w43 = await stats(`van=2026-10-19&tot=2026-10-25&groep=link`);
  const w44 = await stats(`van=2026-10-26&tot=2026-11-01&groep=link`);
  assert.equal(w43.find((r: { link_id: string }) => r.link_id === b).totaal, 2 + 2); // + nieuwsbrief/social van 20 okt
  assert.equal(w44.find((r: { link_id: string }) => r.link_id === b).totaal, 1);
});

test('zomertijdgrens (29 mrt 2026)', async () => {
  klik(a, '2026-03-28T22:59:00Z', '203.0.113.30'); // za 28 mrt 23:59 CET
  klik(a, '2026-03-28T23:00:00Z', '203.0.113.31'); // zo 29 mrt 00:00 CET
  klik(a, '2026-03-29T21:59:00Z', '203.0.113.32'); // zo 29 mrt 23:59 CEST
  klik(a, '2026-03-29T22:00:00Z', '203.0.113.33'); // ma 30 mrt 00:00 CEST
  await flush();
  const r = await stats('van=2026-03-28&tot=2026-03-30&groep=dag');
  assert.deepEqual(r.map((x: { dag: string; totaal: number }) => [x.dag, x.totaal]).sort(), [['2026-03-28', 1], ['2026-03-29', 2], ['2026-03-30', 1]]);
});

test('vorige kalenderweek en ISO-weeknummers', () => {
  assert.deepEqual(vorigeWeek(new Date('2026-10-26T06:00:00Z')), { van: '2026-10-19', tot: '2026-10-25', week: '2026-W43' });
  assert.deepEqual(vorigeWeek(new Date('2026-10-25T23:30:00Z')), { van: '2026-10-19', tot: '2026-10-25', week: '2026-W43' }); // ma 00:30 CET
  assert.equal(vorigeWeek(new Date('2026-10-25T22:30:00Z')).week, '2026-W42'); // zo 23:30 CET: nog dezelfde week
  assert.deepEqual(vorigeWeek(new Date('2027-01-04T06:00:00Z')), { van: '2026-12-28', tot: '2027-01-03', week: '2026-W53' });
  assert.equal(isoWeek(new Date('2027-01-01T00:00:00Z')), '2026-W53');
});

test('weekrapport bevat integriteitscontrole en ondernemersoverzicht', async () => {
  await o.app.inject({ method: 'POST', url: '/api/ondernemers', headers: H, payload: { app: 'zeist', naam: 'Restaurant X', cms_items: ['100'] } });
  await o.wachtrij.schrijfTellers();
  const r = await o.app.inject({ method: 'GET', url: '/api/rapport/week?van=2026-10-19&tot=2026-10-25', headers: H });
  assert.equal(r.statusCode, 200, r.body);
  const j = r.json();
  assert.equal(j.vorige_periode.van, '2026-10-12');
  assert.equal(j.ondernemers[0].ondernemer, 'Restaurant X');
  assert.equal(j.ondernemers[0].geldig, 7);
  assert.ok(j.detail.length > 0);
  assert.equal(typeof j.integriteit.compleet, 'boolean');
  const t = await o.pool.query(`SELECT sleutel, waarde FROM metriek_dag WHERE sleutel IN ('ontvangen','opgeslagen')`);
  const m = Object.fromEntries(t.rows.map((x) => [x.sleutel, Number(x.waarde)]));
  assert.equal(m.ontvangen, m.opgeslagen);
});

test('geen volledige IP-adressen of user-agents in de database', async () => {
  const { rows } = await o.pool.query(`SELECT ip_hash, ua_klasse FROM clicks`);
  for (const r of rows) {
    assert.ok(!r.ip_hash.includes('203.0.113'));
    assert.ok(!r.ua_klasse.includes('Mozilla'));
  }
  const s = await o.pool.query(`SELECT count(*)::int n FROM dag_sleutels`);
  assert.ok(s.rows[0].n >= 1);
});

test('ongeldige periode en groep geven 400', async () => {
  assert.equal((await o.app.inject({ url: '/api/stats?van=2026-13-01&tot=x', headers: H })).statusCode, 400);
  assert.equal((await o.app.inject({ url: '/api/stats?van=2026-10-01&tot=2026-10-02&groep=drop', headers: H })).statusCode, 400);
});
