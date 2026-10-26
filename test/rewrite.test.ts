import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nieuweOmgeving, rewrite, zetModus, H } from './helpers.js';
import { vindLinks, alleenHrefsGewijzigd } from '../src/html.js';

let o: Awaited<ReturnType<typeof nieuweOmgeving>>;
before(async () => {
  o = await nieuweOmgeving();
  await zetModus(o, 'zeist', 'aan');
  await zetModus(o, 'gooisemeren', 'aan');
});
after(async () => o.opruimen());

const basis = { app: 'zeist', cms_item_id: '31919163', rubriek: 'Horeca & Verblijf', pagina_titel: 'De Hoefslag' };

test('één externe link wordt herschreven met UTM in de bestemming', async () => {
  const html = `<p><a href="https://restaurantvoorbeeld.nl/reserveren" target="_blank">Reserveren</a></p>`;
  const r = await rewrite(o, { ...basis, cms_item_id: 'een', html });
  assert.equal(r.status, 200);
  assert.equal(r.json.gevonden, 1);
  assert.equal(r.json.gewijzigd, 1);
  assert.equal(r.json.nieuw, 1);
  const id = r.json.links[0].id;
  assert.match(r.json.html, new RegExp(`href="https://go.zeistapp.nl/r/${id}" target="_blank"`));
  assert.equal(r.json.links[0].doel_url, 'https://restaurantvoorbeeld.nl/reserveren?utm_source=zeistapp&utm_medium=app&utm_campaign=horeca-en-verblijf');
});

test('meerdere links, tel/mail/anker/intern ongemoeid, onveilige links geweigerd', async () => {
  const html = `<a href="https://a.nl">A</a> <a href="mailto:x@y.nl">M</a> <a href="tel:+3130">T</a> <a href="#boven">#</a>
    <a href="/intern">I</a> <a href="javascript:alert(1)">J</a> <a href="http://192.168.0.1/">P</a> <a href="https://b.nl/x?y=1#frag">B</a>`;
  const r = await rewrite(o, { ...basis, cms_item_id: 'meer', html });
  assert.equal(r.json.gevonden, 8);
  assert.equal(r.json.gewijzigd, 2);
  assert.ok(r.json.html.includes('href="mailto:x@y.nl"') && r.json.html.includes('href="tel:+3130"') && r.json.html.includes('href="#boven"') && r.json.html.includes('href="/intern"'));
  assert.ok(r.json.html.includes('href="javascript:alert(1)"'), 'onveilige link blijft staan maar wordt niet geregistreerd');
  assert.equal(r.json.waarschuwingen.length, 2);
  const b = r.json.links.find((l: { label: string }) => l.label === 'B');
  assert.equal(b.doel_url, 'https://b.nl/x?y=1&utm_source=zeistapp&utm_medium=app&utm_campaign=horeca-en-verblijf#frag');
});

test('herhaalde verwerking geeft dezelfde id\'s en geen nieuwe links', async () => {
  const html = `<a href="https://c.nl/a">C</a><a href="https://c.nl/a">C nogmaals</a><a href="https://d.nl">D</a>`;
  const r1 = await rewrite(o, { ...basis, cms_item_id: 'herhaal', html });
  const r2 = await rewrite(o, { ...basis, cms_item_id: 'herhaal', html });
  assert.equal(r1.json.nieuw, 3, 'twee knoppen naar dezelfde bestemming krijgen elk een eigen id');
  assert.equal(r2.json.nieuw, 0);
  assert.equal(r2.json.bestaand, 3);
  assert.deepEqual(r1.json.links.map((l: { id: string }) => l.id), r2.json.links.map((l: { id: string }) => l.id));
  assert.equal(r1.json.html, r2.json.html);
});

test('gewijzigde UTM behoudt id en wordt gelogd', async () => {
  const r1 = await rewrite(o, { ...basis, cms_item_id: 'utm', html: `<a href="https://e.nl/p?utm_source=template">E</a>` });
  const r2 = await rewrite(o, { ...basis, cms_item_id: 'utm', html: `<a href="https://e.nl/p?utm_source=zeistapp&utm_medium=app">E</a>` });
  assert.equal(r1.json.links[0].id, r2.json.links[0].id);
  const d = await o.app.inject({ method: 'GET', url: `/api/links/${r1.json.links[0].id}`, headers: H });
  assert.equal(d.json().doel_url, 'https://e.nl/p?utm_source=zeistapp&utm_medium=app');
  assert.equal(d.json().wijzigingen.length, 1);
});

test('bestaande trackinglinks worden niet dubbel herschreven', async () => {
  const r1 = await rewrite(o, { ...basis, cms_item_id: 'al', html: `<a href="https://f.nl">F</a>` });
  const r2 = await rewrite(o, { ...basis, cms_item_id: 'al', html: r1.json.html });
  assert.equal(r2.json.gewijzigd, 0);
  assert.equal(r2.json.links[0].status, 'al_getrackt');
  assert.equal(r2.json.html, r1.json.html);
});

test('speciale tekens en queryparameters blijven correct', async () => {
  const html = `<p>Café “De Eik” — ✓</p><a href="https://g.nl/zoek?q=caf%C3%A9&amp;x=a%20b&amp;y=&quot;z&quot;">G &amp; co</a>`;
  const r = await rewrite(o, { ...basis, cms_item_id: 'tekens', html });
  assert.ok(alleenHrefsGewijzigd(html, r.json.html));
  assert.ok(r.json.html.startsWith('<p>Café “De Eik” — ✓</p>'));
  assert.equal(r.json.links[0].label, 'G & co');
  assert.equal(r.json.links[0].oorspronkelijke_url, 'https://g.nl/zoek?q=caf%C3%A9&x=a%20b&y="z"');
});

test('echte Pagina Wizard-HTML: alleen externe links gewijzigd, bestaande UTM behouden', async () => {
  const html = readFileSync(new URL('./fixture-wizard.html', import.meta.url), 'utf8');
  const r = await rewrite(o, { ...basis, cms_item_id: 'wizard', rubriek: 'Sport & Bewegen', html });
  assert.equal(r.status, 200);
  assert.ok(alleenHrefsGewijzigd(html, r.json.html));
  const extern = vindLinks(html).filter((l) => /^https?:/.test(l.href)).length;
  assert.equal(r.json.gewijzigd, extern);
  const faq = r.json.links.find((l: { oorspronkelijke_url: string }) => l.oorspronkelijke_url.includes('/faq/'));
  assert.equal(faq.doel_url, 'https://boulderneoliet.nl/nl/faq/?utm_source=template&utm_medium=app');
  assert.ok(r.json.html.includes('href="tel:+31107171805"'));
});

test('proefmodus maakt geen links aan en geeft html ongewijzigd terug', async () => {
  const html = `<a href="https://h.nl">H</a>`;
  const r = await rewrite(o, { ...basis, cms_item_id: 'proef', html, dry_run: true });
  assert.equal(r.json.modus, 'dry_run');
  assert.equal(r.json.html, html);
  assert.equal(r.json.nieuw, 1);
  const l = await o.app.inject({ method: 'GET', url: '/api/links?cms_item_id=proef', headers: H });
  assert.equal(l.json().totaal, 0);
});

test('modus per app: dry_run als standaard voor gefaseerde inschakeling', async () => {
  await zetModus(o, 'gooisemeren', 'dry_run');
  const r = await rewrite(o, { ...basis, app: 'gooisemeren', cms_item_id: 'gm1', html: `<a href="https://i.nl">I</a>` });
  assert.equal(r.json.modus, 'dry_run');
  assert.equal(r.json.gewijzigd, 0);
  await zetModus(o, 'gooisemeren', 'aan');
  const r2 = await rewrite(o, { ...basis, app: 'gooisemeren', cms_item_id: 'gm1', html: `<a href="https://i.nl">I</a>` });
  assert.match(r2.json.html, /https:\/\/go\.gooisemerenapp\.nl\/r\/[A-Za-z0-9]{8}/);
  assert.match(r2.json.links[0].doel_url, /utm_source=gooisemerenapp/);
});

test('bron nieuwsbrief: zelfde link-id met ?b=nieuwsbrief, onbekende bron geweigerd', async () => {
  const html = `<a href="https://j.nl">J</a>`;
  const r = await rewrite(o, { ...basis, cms_item_id: 'nb', html, bron: 'nieuwsbrief' });
  assert.match(r.json.html, /\/r\/[A-Za-z0-9]{8}\?b=nieuwsbrief"/);
  assert.match(r.json.links[0].doel_url, /utm_medium=nieuwsbrief/);
  const f = await rewrite(o, { ...basis, cms_item_id: 'nb', html, bron: 'hack' });
  assert.equal(f.status, 400);
});

test('handmatig vastgezette bestemming wordt niet overschreven door herverwerking', async () => {
  const r = await rewrite(o, { ...basis, cms_item_id: 'vast', html: `<a href="https://k.nl/oud">K</a>` });
  const id = r.json.links[0].id;
  const p = await o.app.inject({ method: 'PATCH', url: `/api/links/${id}`, headers: H, payload: { doel_url: 'https://k.nl/oud-gerepareerd' } });
  assert.equal(p.statusCode, 200);
  const r2 = await rewrite(o, { ...basis, cms_item_id: 'vast', html: `<a href="https://k.nl/oud">K</a>` });
  assert.equal(r2.json.links[0].doel_url, 'https://k.nl/oud-gerepareerd');
  assert.ok(r2.json.waarschuwingen.some((w: string) => w.includes('vastgezette')));
});

test('autorisatie: zonder sleutel 401, leesrecht mag niet herschrijven', async () => {
  const z = await o.app.inject({ method: 'POST', url: '/api/rewrite', payload: { ...basis, html: '' } });
  assert.equal(z.statusCode, 401);
  const c = await o.app.inject({ method: 'POST', url: '/api/clients', headers: H, payload: { naam: 'sheets', recht: 'lezen' } });
  const key = c.json().api_key;
  const r = await o.app.inject({ method: 'POST', url: '/api/rewrite', headers: { 'x-api-key': key }, payload: { ...basis, html: '' } });
  assert.equal(r.statusCode, 403);
  const l = await o.app.inject({ method: 'GET', url: '/api/links', headers: { 'x-api-key': key } });
  assert.equal(l.statusCode, 200);
  await o.app.inject({ method: 'DELETE', url: '/api/clients/sheets', headers: H });
  const na = await o.app.inject({ method: 'GET', url: '/api/links', headers: { 'x-api-key': key } });
  assert.equal(na.statusCode, 401);
});

test('PATCH weigert redirectlus en onveilige bestemming', async () => {
  const r = await rewrite(o, { ...basis, cms_item_id: 'lus', html: `<a href="https://l.nl">L</a>` });
  const id = r.json.links[0].id;
  for (const doel of ['https://go.zeistapp.nl/r/AAAAAAAA', 'javascript:alert(1)', 'http://127.0.0.1/']) {
    const p = await o.app.inject({ method: 'PATCH', url: `/api/links/${id}`, headers: H, payload: { doel_url: doel } });
    assert.equal(p.statusCode, 400, doel);
  }
});

test('ondernemer koppelen via host en cms-item', async () => {
  const r = await rewrite(o, { ...basis, cms_item_id: 'ond', html: `<a href="https://www.restaurantx.nl/menu">Menu</a><a href="https://maps.google.com/?q=x">Route</a>` });
  const p = await o.app.inject({ method: 'POST', url: '/api/ondernemers', headers: H, payload: { app: 'zeist', naam: 'Restaurant X', hosts: ['restaurantx.nl'] } });
  assert.equal(p.json().gekoppelde_links, 1);
  const p2 = await o.app.inject({ method: 'POST', url: '/api/ondernemers', headers: H, payload: { app: 'zeist', naam: 'Restaurant X', cms_items: ['ond'] } });
  assert.equal(p2.json().gekoppelde_links, 1, 'routelink op zijn eigen pagina telt ook mee');
  // Nieuwe pagina met link naar zijn site wordt bij aanmaken direct gekoppeld
  const r2 = await rewrite(o, { ...basis, cms_item_id: 'nieuws1', html: `<a href="https://restaurantx.nl/actie">Actie</a>` });
  const d = await o.app.inject({ method: 'GET', url: `/api/links/${r2.json.links[0].id}`, headers: H });
  assert.equal(d.json().ondernemer_id, p.json().id);
  assert.ok(r.json.links.length === 2);
});

test('voorlopige sleutel omkoppelen naar echt CMS-item behoudt link-id\'s', async () => {
  const html = `<a href="https://m.nl/a">A</a><a href="https://m.nl/b">B</a>`;
  const r = await rewrite(o, { ...basis, cms_item_id: 'tmp:persbericht:123', html });
  const ids = r.json.links.map((l: { id: string }) => l.id);
  const h = await o.app.inject({ method: 'POST', url: '/api/links/herkoppel', headers: H, payload: { app: 'zeist', van_cms_item_id: 'tmp:persbericht:123', naar_cms_item_id: '32300001', pagina_titel: 'Persbericht X' } });
  assert.equal(h.json().verplaatst, 2);
  const l = await o.app.inject({ method: 'GET', url: '/api/links?cms_item_id=32300001', headers: H });
  assert.deepEqual(l.json().links.map((x: { id: string }) => x.id).sort(), [...ids].sort());
  // latere herverwerking op het echte id hergebruikt dezelfde links
  const r2 = await rewrite(o, { ...basis, cms_item_id: '32300001', html });
  assert.equal(r2.json.nieuw, 0);
});
