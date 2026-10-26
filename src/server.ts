import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from './db.js';
import { Cache } from './cache.js';
import { KlikWachtrij } from './wachtrij.js';
import { DagSleutels } from './privacy.js';
import { registreerRedirect } from './redirect.js';
import { registreerApi } from './api.js';
import { config } from './config.js';

export interface Onderdelen {
  app: FastifyInstance;
  cache: Cache;
  wachtrij: KlikWachtrij;
}

export async function bouwServer(pool: Pool, opties: { logger?: boolean } = {}): Promise<Onderdelen> {
  const app = Fastify({
    logger: opties.logger ? { level: 'info' } : false,
    trustProxy: true,
    bodyLimit: 3 * 1024 * 1024,
  });
  const cache = new Cache(pool, config.cacheTtlMs);
  const wachtrij = new KlikWachtrij(pool, new DagSleutels(pool), {
    max: config.wachtrijMax,
    batch: config.batchGrootte,
    intervalMs: config.flushIntervalMs,
    dubbelVensterMs: config.dubbelVensterMs,
  });

  await app.register(rateLimit, {
    global: false,
  });

  // Redirects: ruime limiet per IP, alleen tegen misbruik
  app.register(async (scope) => {
    await scope.register(rateLimit, { max: config.rateLimitRedirect, timeWindow: '1 minute' });
    registreerRedirect(scope, cache, wachtrij);
  });
  app.register(async (scope) => {
    await scope.register(rateLimit, { max: config.rateLimitApi, timeWindow: '1 minute' });
    registreerApi(scope, pool, cache, wachtrij);
  });

  /** Healthcheck. Standaard 200 zolang het proces redirects kan uitvoeren (ook uit cache).
   *  Met ?strikt=1 503 bij database- of wachtrijproblemen: voor de onafhankelijke uptimecontrole. */
  app.get('/health', async (req, reply) => {
    let db = false;
    try {
      await pool.query('SELECT 1');
      db = true;
    } catch { /* hieronder gemeld */ }
    const achterstand = wachtrij.diepte > config.wachtrijMax * 0.5;
    const flushOud = wachtrij.diepte > 0 && (!wachtrij.laatsteFlushOk || Date.now() - wachtrij.laatsteFlushOk.getTime() > 120_000);
    const status = db && !achterstand && !flushOud ? 'ok' : 'verminderd';
    const strikt = (req.query as { strikt?: string }).strikt === '1';
    reply.header('Cache-Control', 'no-store');
    reply.code(strikt && status !== 'ok' ? 503 : 200);
    return {
      status, database: db, links_in_cache: cache.grootte,
      wachtrij: { diepte: wachtrij.diepte, verworpen: wachtrij.tellers.verworpen, laatste_flush_ok: wachtrij.laatsteFlushOk },
      versie: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? 'lokaal',
    };
  });

  const hier = dirname(fileURLToPath(import.meta.url));
  const spec = [join(hier, 'openapi.yaml'), join(hier, '..', 'openapi.yaml')].find(existsSync);
  app.get('/openapi.yaml', async (_req, reply) => {
    reply.header('Content-Type', 'application/yaml; charset=utf-8');
    return spec ? readFileSync(spec, 'utf8') : '';
  });

  app.get('/', async (_req, reply) => {
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    return 'BuurtApps linktracker';
  });
  app.get('/robots.txt', async (_req, reply) => {
    reply.header('Content-Type', 'text/plain');
    return 'User-agent: *\nDisallow: /\n';
  });

  return { app, cache, wachtrij };
}
