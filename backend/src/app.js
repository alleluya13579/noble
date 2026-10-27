// Assembles the API: database, routes, auth, scheduler. `createApp` is used by server.js and by tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter, serve } from './http.js';
import { openDatabase } from './db.js';
import { makeAuth, registerAuthRoutes } from './auth.js';
import { registerListingRoutes } from './listings.js';
import { registerThreadRoutes } from './threads.js';
import { registerTransactionRoutes } from './transactions.js';
import { registerAdminRoutes } from './admin.js';
import { startScheduler } from './scheduler.js';
import { config, integrationStatus } from './config.js';

export async function createApp({ dbPath = config.dbTarget, scheduler = true, logger = console } = {}) {
  const db = await openDatabase(dbPath);
  const r = createRouter();
  const here = path.dirname(fileURLToPath(import.meta.url));
  r.get('/', () => ({ name: 'Noble API', version: '0.1.0', database: db.dialect, docs: '/openapi.yaml', app: '/app', integrations: integrationStatus().map(i => `${i.kind}:${i.id}=${i.mode}`) }));
  r.get('/health', async () => ({ ok: true, database: db.dialect, time: new Date().toISOString(), countries: (await db.get('SELECT COUNT(*) n FROM countries')).n }));
  r.get('/openapi.yaml', () => ({ __file: true, contentType: 'application/yaml', bytes: fs.readFileSync(path.join(here, '..', 'openapi.yaml')) }));
  // The web client (web/index.html) is served by the API itself, so one process is the whole product.
  r.get('/app', () => ({ __file: true, contentType: 'text/html; charset=utf-8', bytes: fs.readFileSync(path.join(here, '..', '..', 'web', 'index.html')) }));
  registerAuthRoutes(r, db);
  registerListingRoutes(r, db);
  registerThreadRoutes(r, db);
  registerTransactionRoutes(r, db);
  registerAdminRoutes(r, db);
  const server = serve(r, { authenticate: makeAuth(db), logger });
  const stop = scheduler ? startScheduler(db, 60e3, logger) : () => {};
  return { server, db, close: () => new Promise(res => { stop(); server.close(async () => { await db.close(); res(); }); }) };
}
