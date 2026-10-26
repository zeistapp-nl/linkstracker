import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { nieuweOmgeving, rewrite, zetModus, H } from './helpers.js';

let o: Awaited<ReturnType<typeof nieuweOmgeving>>;
let zeistId: string;
let gmId: string;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

before(async () => {
  o = await nieuweOmgeving();
  await zetModus(o, 'zeist', 'aan');
  await zetModus(o, 'gooisemeren', 'aan');
  zeistId = (await rewrite(o, { app: 'zeist', cms_item_id: '1', html: `<a href="https://a.nl/x">A</a>` })).json.links[0].id;
  gmId = (await rewrite(o, { app: 'gooisemeren', cms_item_id: '1', html: `<a href="https://b.nl/y">B</a>` })).json.links[0].id;
});
after(async () => o.opruimen());

const get = (host: string, pad: string, extra: Record<string, string> = {}) =>
  o.app.inject({ method: 'GET', url: pad, headers: { host, 'user-agent': IPHONE, ...extra } });

async function wachtTotLeeg() {
  for (let i = 0; i < 100 && o.wachtrij.diepte; i++) await o.wachtrij.flush(true);
}

test('geldige link ZeistApp: 302, no-store, juiste bestemming', async () => {
  const r = await get('go.zeistapp.nl', `/r/${zeistId}`);
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers.location, 'https://a.nl/x?utm_source=zeistapp&utm_medium=app');
  assert.match(String(r.headers['cache-control']), /no-store/);
});

test('geldige link GooiseMerenApp', async () => {
  const r = await get('go.gooisemerenapp.nl', `/r/${gmId}`);
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers.location, 'https://b.nl/y?utm_source=gooisemerenapp&utm_medium=app');
});

test('onbekend en ongeldig id: eigen melding in de app-webview, geen doorsturing naar een website', async () => {
  const a = await get('go.zeistapp.nl', '/r/ZZZZZZZZ');
  assert.equal(a.statusCode, 404);
  assert.equal(a.headers.location, undefined);
  assert.match(a.body, /niet meer beschikbaar/);
  assert.match(a.body, /ZeistApp/);
  const b = await get('go.gooisemerenapp.nl', '/r/kort');
  assert.equal(b.statusCode, 404);
  assert.match(b.body, /GooiseMerenApp/);
});

test('onjuist app-domein: niet naar bestemming, wel geregistreerd als domein_mismatch', async () => {
  const r = await get('go.gooisemerenapp.nl', `/r/${zeistId}`);
  assert.equal(r.statusCode, 410);
  assert.equal(r.headers.location, undefined);
  await wachtTotLeeg();
  const { rows } = await o.pool.query(`SELECT classificatie FROM clicks WHERE link_id = $1 ORDER BY id DESC LIMIT 1`, [zeistId]);
  assert.equal(rows[0].classificatie, 'domein_mismatch');
});

test('inactieve link: naar fallback', async () => {
  const id = (await rewrite(o, { app: 'zeist', cms_item_id: '2', html: `<a href="https://c.nl">C</a>` })).json.links[0].id;
  await o.app.inject({ method: 'PATCH', url: `/api/links/${id}`, headers: H, payload: { actief: false } });
  const r = await get('go.zeistapp.nl', `/r/${id}`);
  assert.equal(r.statusCode, 410);
  assert.match(r.body, /niet meer beschikbaar/);
});

test('gewijzigde doel-URL werkt direct', async () => {
  const id = (await rewrite(o, { app: 'zeist', cms_item_id: '3', html: `<a href="https://d.nl/oud">D</a>` })).json.links[0].id;
  await o.app.inject({ method: 'PATCH', url: `/api/links/${id}`, headers: H, payload: { doel_url: 'https://d.nl/nieuw' } });
  assert.equal((await get('go.zeistapp.nl', `/r/${id}`)).headers.location, 'https://d.nl/nieuw');
});

test('HEAD telt niet als klik', async () => {
  await wachtTotLeeg();
  const voor = o.wachtrij.tellers.ontvangen;
  const r = await o.app.inject({ method: 'HEAD', url: `/r/${zeistId}`, headers: { host: 'go.zeistapp.nl' } });
  assert.equal(r.statusCode, 302);
  assert.equal(o.wachtrij.tellers.ontvangen, voor);
  assert.ok(o.wachtrij.tellers.head >= 1);
});

test('redirectlus in database wordt alsnog afgevangen', async () => {
  const id = (await rewrite(o, { app: 'zeist', cms_item_id: '4', html: `<a href="https://e.nl">E</a>` })).json.links[0].id;
  await o.pool.query(`UPDATE links SET doel_url = 'https://go.zeistapp.nl/r/${id}' WHERE id = $1`, [id]);
  await o.cache.laadAlles();
  const r = await get('go.zeistapp.nl', `/r/${id}`);
  assert.equal(r.statusCode, 410);
  assert.equal(r.headers.location, undefined);
});

test('neutrale host (Railway-adres vóór DNS) stuurt door en wordt herkenbaar geregistreerd', async () => {
  const r = await get('linktracker-production.up.railway.app', `/r/${zeistId}`);
  assert.equal(r.headers.location, 'https://a.nl/x?utm_source=zeistapp&utm_medium=app');
  await wachtTotLeeg();
  const { rows } = await o.pool.query(`SELECT classificatie FROM clicks WHERE link_id = $1 ORDER BY id DESC LIMIT 1`, [zeistId]);
  assert.equal(rows[0].classificatie, 'neutrale_host');
});

test('database onbereikbaar: bekende links blijven werken, klikken blijven in wachtrij en worden later opgeslagen', async () => {
  await wachtTotLeeg();
  const { rows: [{ n: voor }] } = await o.pool.query(`SELECT count(*)::int n FROM clicks`);
  const echteQuery = o.pool.query.bind(o.pool);
  const echteConnect = o.pool.connect.bind(o.pool);
  (o.pool as unknown as { query: unknown }).query = async () => { throw new Error('verbinding verbroken'); };
  (o.pool as unknown as { connect: unknown }).connect = async () => { throw new Error('verbinding verbroken'); };
  try {
    // cache verlopen maken: moet toch de bekende bestemming geven
    const r = await get('go.zeistapp.nl', `/r/${zeistId}`);
    assert.equal(r.statusCode, 302);
    assert.equal(r.headers.location, 'https://a.nl/x?utm_source=zeistapp&utm_medium=app');
    // Onbekende link zonder cache: naar fallback, geen hangende gebruiker
    const r2 = await get('go.zeistapp.nl', `/r/QQQQQQQQ`);
    assert.equal(r2.statusCode, 503);
    const ok = await o.wachtrij.flush(true);
    assert.equal(ok, false);
    assert.equal(o.wachtrij.diepte, 1, 'klik blijft bewaard');
  } finally {
    (o.pool as unknown as { query: unknown }).query = echteQuery;
    (o.pool as unknown as { connect: unknown }).connect = echteConnect;
  }
  await wachtTotLeeg();
  const { rows: [{ n: na }] } = await o.pool.query(`SELECT count(*)::int n FROM clicks`);
  assert.equal(na, voor + 1);
});

test('volle wachtrij: verworpen kliks worden geteld, redirect blijft werken', async () => {
  const w = o.wachtrij as unknown as { opties: { max: number } };
  const oud = w.opties.max;
  w.opties.max = 0;
  const voor = o.wachtrij.tellers.verworpen;
  const r = await get('go.zeistapp.nl', `/r/${zeistId}`);
  w.opties.max = oud;
  assert.equal(r.statusCode, 302);
  assert.equal(o.wachtrij.tellers.verworpen, voor + 1);
});

test('health: 200 normaal, strikt 503 als database weg is', async () => {
  assert.equal((await o.app.inject({ url: '/health?strikt=1' })).statusCode, 200);
  const echt = o.pool.query.bind(o.pool);
  (o.pool as unknown as { query: unknown }).query = async () => { throw new Error('weg'); };
  try {
    assert.equal((await o.app.inject({ url: '/health' })).statusCode, 200);
    assert.equal((await o.app.inject({ url: '/health?strikt=1' })).statusCode, 503);
  } finally {
    (o.pool as unknown as { query: unknown }).query = echt;
  }
});

test('bronparameter kan de bestemming niet beïnvloeden', async () => {
  const r = await get('go.zeistapp.nl', `/r/${zeistId}?b=https://kwaad.nl&url=https://kwaad.nl`);
  assert.equal(r.headers.location, 'https://a.nl/x?utm_source=zeistapp&utm_medium=app');
  await wachtTotLeeg();
  const { rows } = await o.pool.query(`SELECT bron FROM clicks WHERE link_id = $1 ORDER BY id DESC LIMIT 1`, [zeistId]);
  assert.equal(rows[0].bron, 'onbekend');
});
