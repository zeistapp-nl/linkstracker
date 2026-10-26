import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { controleer, _testStaPriveToe } from '../src/linkcheck.js';

let srv: http.Server;
let basis: string;

before(async () => {
  srv = http.createServer((req, res) => {
    const p = req.url ?? '/';
    if (p === '/ok') return res.writeHead(200).end('ok');
    if (p === '/weg') return res.writeHead(404).end();
    if (p === '/verdwenen') return res.writeHead(410).end();
    if (p === '/geenhead') return req.method === 'HEAD' ? res.writeHead(405).end() : res.writeHead(200).end('ok');
    if (p === '/druk') return res.writeHead(429).end();
    if (p === '/fout') return res.writeHead(503).end();
    if (p === '/verboden') return res.writeHead(403).end();
    if (p === '/lus1') return res.writeHead(302, { Location: '/lus2' }).end();
    if (p === '/lus2') return res.writeHead(302, { Location: '/lus1' }).end();
    if (p === '/door') return res.writeHead(301, { Location: '/ok' }).end();
    if (p === '/traag') return; // nooit antwoorden
    res.writeHead(500).end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  basis = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
after(() => { _testStaPriveToe(false); srv.closeAllConnections(); srv.close(); });

test('classificatie van bestemmingen', async () => {
  _testStaPriveToe(true);
  assert.equal((await controleer(`${basis}/ok`)).resultaat, 'ok');
  assert.equal((await controleer(`${basis}/door`)).resultaat, 'ok');
  assert.equal((await controleer(`${basis}/weg`)).resultaat, 'definitief');
  assert.equal((await controleer(`${basis}/verdwenen`)).resultaat, 'definitief');
  assert.equal((await controleer(`${basis}/geenhead`)).resultaat, 'ok', 'HEAD geblokkeerd: GET als terugval');
  assert.equal((await controleer(`${basis}/druk`)).resultaat, 'tijdelijk', '429 is nooit definitief');
  assert.equal((await controleer(`${basis}/fout`)).resultaat, 'tijdelijk', '5xx is nooit definitief');
  assert.equal((await controleer(`${basis}/verboden`)).resultaat, 'tijdelijk', '403 is nooit definitief');
  assert.equal((await controleer(`${basis}/lus1`)).resultaat, 'loop');
  assert.equal((await controleer(`${basis}/traag`, 500)).resultaat, 'timeout');
});

test('interne adressen worden geweigerd (geen SSRF)', async () => {
  _testStaPriveToe(false);
  assert.equal((await controleer(`${basis}/ok`)).resultaat, 'ongeldig');
  assert.equal((await controleer('http://localhost/')).resultaat, 'ongeldig');
  assert.equal((await controleer('http://169.254.169.254/latest/meta-data/')).resultaat, 'ongeldig');
});

test('niet-bestaand domein geeft dns', async () => {
  const r = await controleer('https://dit-domein-bestaat-echt-niet-7x9q.nl/');
  assert.ok(['dns', 'tijdelijk'].includes(r.resultaat), JSON.stringify(r));
});
