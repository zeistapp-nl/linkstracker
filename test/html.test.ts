import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { vindLinks, vervangHrefs, alleenHrefsGewijzigd } from '../src/html.js';
import { beoordeelUrl, sleutelUrl, metUtm } from '../src/url.js';

test('vindt links met exacte posities, ook bij enkele en ontbrekende quotes', () => {
  const html = `<p>a <a href="https://x.nl/a?b=1&amp;c=2#d">Een</a> <a class='k' href='https://y.nl'>Twee</a> <a href=https://z.nl/>Drie</a></p>`;
  const l = vindLinks(html);
  assert.equal(l.length, 3);
  assert.equal(l[0].href, 'https://x.nl/a?b=1&c=2#d'); // entiteiten gedecodeerd
  assert.equal(html.slice(l[0].start, l[0].eind), 'href="https://x.nl/a?b=1&amp;c=2#d"');
  assert.equal(l[1].quote, "'");
  assert.equal(l[2].quote, '');
  assert.deepEqual(l.map((x) => x.label), ['Een', 'Twee', 'Drie']);
});

test('vervangen laat alle overige tekens byte-voor-byte gelijk', () => {
  const html = `<div style="x">é ✓ &nbsp; <a target="_blank" rel="noopener" href="https://x.nl/?q=1">Klik</a><!-- c --><img src="a.png"></div>`;
  const l = vindLinks(html);
  const nieuw = vervangHrefs(html, [{ start: l[0].start, eind: l[0].eind, nieuweHref: 'https://go.zeistapp.nl/r/AbCdEf23', quote: l[0].quote }]);
  assert.equal(nieuw, html.replace('href="https://x.nl/?q=1"', 'href="https://go.zeistapp.nl/r/AbCdEf23"'));
  assert.ok(nieuw.includes('target="_blank" rel="noopener"'));
  assert.ok(alleenHrefsGewijzigd(html, nieuw));
  assert.ok(!alleenHrefsGewijzigd(html, nieuw.replace('Klik', 'Klik!')));
});

test('volledig document (doctype/html) wordt ook correct gelezen', () => {
  const html = `<!doctype html><html><head><title>t</title></head><body><a href="https://x.nl">x</a></body></html>`;
  const l = vindLinks(html);
  assert.equal(l.length, 1);
  assert.equal(html.slice(l[0].start, l[0].eind), 'href="https://x.nl"');
});

test('echte Pagina Wizard-HTML: alle links gevonden en vervanging raakt niets anders', () => {
  const html = readFileSync(new URL('./fixture-wizard.html', import.meta.url), 'utf8');
  const l = vindLinks(html);
  const regex = [...html.matchAll(/<a\s[^>]*href=/gi)].length;
  assert.equal(l.length, regex);
  const vervangingen = l.filter((x) => x.href.startsWith('http')).map((x) => ({ start: x.start, eind: x.eind, nieuweHref: 'https://go.zeistapp.nl/r/TESTTEST', quote: x.quote }));
  const nieuw = vervangHrefs(html, vervangingen);
  assert.ok(alleenHrefsGewijzigd(html, nieuw));
  assert.equal(nieuw.length - html.length, vervangingen.reduce((s, v) => s + ('href="https://go.zeistapp.nl/r/TESTTEST"'.length - (v.eind - v.start)), 0));
});

test('URL-beoordeling: veilig, onveilig en niet-http', () => {
  assert.equal(beoordeelUrl('https://www.x.nl/a').ok, true);
  for (const [u, reden] of [
    ['javascript:alert(1)', 'protocol_javascript'], ['mailto:a@b.nl', 'protocol_mailto'], ['tel:+31', 'protocol_tel'],
    ['#anker', 'geen_absolute_url'], ['/intern', 'geen_absolute_url'], ['http://localhost/x', 'interne_host'],
    ['http://192.168.1.1/', 'prive_ip'], ['http://10.0.0.5/', 'prive_ip'], ['http://[::1]/', 'prive_ip'],
    ['https://user:pw@x.nl/', 'inloggegevens_in_url'], ['http://intranet/', 'host_zonder_domein'], ['http://x.nl:22/', 'ongebruikelijke_poort'],
  ] as const) {
    const o = beoordeelUrl(u);
    assert.equal(o.ok, false, u);
    if (!o.ok) assert.equal(o.reden, reden, u);
  }
});

test('sleutel-URL negeert utm, fragment, volgorde en http/https', () => {
  const a = sleutelUrl(new URL('https://X.nl/pad?b=2&a=1&utm_source=zeistapp#top'));
  const b = sleutelUrl(new URL('http://x.nl/pad?a=1&b=2&utm_source=anders'));
  assert.equal(a, b);
  assert.notEqual(a, sleutelUrl(new URL('https://x.nl/pad?a=1')));
});

test('UTM alleen toevoegen als er nog geen is en host niet is uitgezonderd', () => {
  const r = metUtm(new URL('https://x.nl/a?q=1#f'), { source: 'zeistapp', medium: 'app', campaign: 'horeca', uitzonderingen: ['boek.nl'] });
  assert.equal(r.url, 'https://x.nl/a?q=1&utm_source=zeistapp&utm_medium=app&utm_campaign=horeca#f');
  assert.equal(metUtm(new URL('https://x.nl/?utm_source=template'), { source: 'zeistapp', medium: 'app', uitzonderingen: [] }).toegevoegd, false);
  assert.equal(metUtm(new URL('https://www.boek.nl/'), { source: 'zeistapp', medium: 'app', uitzonderingen: ['boek.nl'] }).toegevoegd, false);
});
