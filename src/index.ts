import { config } from './config.js';
import { maakPool, migreer, registreerFout } from './db.js';
import { bouwServer } from './server.js';

function log(bericht: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ niveau: 'info', bericht, ...extra }));
}

async function main() {
  if (!config.databaseUrl) throw new Error('DATABASE_URL ontbreekt');
  const pool = maakPool(config.databaseUrl);
  const uitgevoerd = await migreer(pool);
  if (uitgevoerd.length) log('migraties uitgevoerd', { uitgevoerd });

  const { app, cache, wachtrij } = await bouwServer(pool, { logger: false });
  await cache.laadAlles();
  log('cache geladen', { links: cache.grootte, apps: cache.apps.size });
  wachtrij.start();

  // Achtergrondtaken
  const taken: NodeJS.Timeout[] = [];
  taken.push(setInterval(() => void wachtrij.schrijfTellers(), 60_000));
  taken.push(setInterval(() => void cache.laadAlles().catch(() => { cache.dbOk = false; }), 5 * 60_000));
  const opruimen = async () => {
    try {
      const k = await pool.query(`DELETE FROM clicks WHERE ts < now() - make_interval(days => $1)`, [config.retentieDagen]);
      await pool.query(`DELETE FROM dag_sleutels WHERE dag < (now() AT TIME ZONE 'Europe/Amsterdam')::date - 1`);
      await pool.query(`DELETE FROM fouten WHERE tijdstip < now() - interval '90 days'`);
      await pool.query(`DELETE FROM verwerkingen WHERE tijdstip < now() - make_interval(days => $1)`, [config.retentieDagen]);
      await pool.query(`DELETE FROM metriek_dag WHERE dag < current_date - $1::int`, [config.retentieDagen]);
      if (k.rowCount) log('retentie toegepast', { verwijderde_kliks: k.rowCount });
    } catch (e) {
      await registreerFout(pool, 'opruimen', { bericht: (e as Error).message });
    }
  };
  void opruimen();
  taken.push(setInterval(() => void opruimen(), 6 * 3600_000));
  for (const t of taken) t.unref();

  await app.listen({ port: config.port, host: '0.0.0.0' });
  log('gestart', { poort: config.port });

  let bezig = false;
  const afsluiten = async (signaal: string) => {
    if (bezig) return;
    bezig = true;
    log('afsluiten', { signaal, wachtrij: wachtrij.diepte });
    for (const t of taken) clearInterval(t);
    await app.close().catch(() => {});
    await wachtrij.stop(8000);
    await pool.end().catch(() => {});
    log('afgesloten');
    process.exit(0);
  };
  process.on('SIGTERM', () => void afsluiten('SIGTERM'));
  process.on('SIGINT', () => void afsluiten('SIGINT'));
}

main().catch((e) => {
  console.error(JSON.stringify({ niveau: 'fataal', bericht: (e as Error).message }));
  process.exit(1);
});
