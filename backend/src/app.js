// Assembles the API: database, routes, auth, scheduler, operational endpoints. Used by server.js and tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter, serve, memoryLimiter, createMetrics, forbidden } from './http.js';
import { openDatabase } from './db.js';
import { makeAuth, registerAuthRoutes } from './auth.js';
import { registerListingRoutes } from './listings.js';
import { registerThreadRoutes } from './threads.js';
import { registerTransactionRoutes } from './transactions.js';
import { registerAdminRoutes } from './admin.js';
import { registerNotificationRoutes } from './notifications.js';
import { startScheduler } from './scheduler.js';
import { config, integrationStatus, productionProblems } from './config.js';

const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src * data: blob:; connect-src *; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export async function createApp({ dbPath = config.dbTarget, scheduler = true, logger = console } = {}) {
  const problems = productionProblems();
  if (problems.length) throw new Error('refusing to start in production:\n  - ' + problems.join('\n  - '));
  const db = await openDatabase(dbPath);
  const r = createRouter();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const metrics = createMetrics();
  const started = Date.now();

  r.get('/', () => ({ name: 'Noble API', version: '0.1.0', database: db.dialect, docs: '/openapi.yaml', app: '/app', integrations: integrationStatus().map(i => `${i.kind}:${i.id}=${i.mode}`) }));
  r.get('/health', () => ({ ok: true, database: db.dialect, uptime_s: Math.round((Date.now() - started) / 1000), time: new Date().toISOString() }));
  r.get('/ready', async () => { try { await db.ping(); return { ready: true, database: db.dialect, countries: (await db.get('SELECT COUNT(*) n FROM countries')).n }; } catch (e) { return [503, { ready: false, error: e.message }]; } });
  r.get('/metrics', async ctx => {
    if (config.metricsToken && ctx.req.headers.authorization !== `Bearer ${config.metricsToken}`) throw forbidden('metrics token required');
    const states = await db.all('SELECT state, COUNT(*) n FROM transactions GROUP BY state');
    const extra = ['# TYPE noble_transactions gauge', ...states.map(s => `noble_transactions{state="${s.state}"} ${s.n}`), '# TYPE noble_listings_pending gauge', `noble_listings_pending ${(await db.get("SELECT COUNT(*) n FROM listings WHERE status = 'pending'")).n}`];
    return { __file: true, contentType: 'text/plain; version=0.0.4', bytes: Buffer.from(metrics.render(extra)) };
  });
  r.get('/openapi.yaml', () => ({ __file: true, contentType: 'application/yaml', bytes: fs.readFileSync(path.join(here, '..', 'openapi.yaml')), cache: 'public, max-age=300' }));
  // The web client (web/index.html) is served by the API itself, so one process is the whole product.
  r.get('/app', () => ({ __file: true, contentType: 'text/html; charset=utf-8', bytes: fs.readFileSync(path.join(here, '..', '..', 'web', 'index.html')) }));

  registerAuthRoutes(r, db);
  registerListingRoutes(r, db);
  registerThreadRoutes(r, db);
  registerTransactionRoutes(r, db);
  registerAdminRoutes(r, db);
  registerNotificationRoutes(r, db);

  const server = serve(r, { authenticate: makeAuth(db), logger: Object.assign(Object.create(logger), { json: config.logJson }), corsOrigins: config.corsOrigins, trustProxy: config.trustProxy, bodyLimit: Math.max(config.maxUploadBytes, 1024 * 1024), limiter: memoryLimiter({ limit: config.ipRateLimit, windowMs: 60e3 }), metrics, csp: CSP });
  const stop = scheduler ? startScheduler(db, 60e3, logger) : () => {};
  return { server, db, metrics, close: () => new Promise(res => { stop(); server.close(async () => { await db.close(); res(); }); }) };
}
