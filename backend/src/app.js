// Assembles the API: database, routes, auth, scheduler. `createApp` is used by server.js and by tests.
import { createRouter, serve } from './http.js';
import { openDatabase } from './db.js';
import { makeAuth, registerAuthRoutes } from './auth.js';
import { registerListingRoutes } from './listings.js';
import { registerThreadRoutes } from './threads.js';
import { registerTransactionRoutes } from './transactions.js';
import { registerAdminRoutes } from './admin.js';
import { startScheduler } from './scheduler.js';
import { config, integrationStatus } from './config.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function createApp({ dbPath = config.dbPath, scheduler = true, logger = console } = {}) {
  const db = openDatabase(dbPath);
  const r = createRouter();
  r.get('/', () => ({ name: 'Noble API', version: '0.1.0', docs: '/openapi.yaml', integrations: integrationStatus().map(i => `${i.kind}:${i.id}=${i.mode}`) }));
  r.get('/openapi.yaml', () => ({ __file: true, contentType: 'application/yaml', bytes: fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'openapi.yaml')) }));
  r.get('/health', () => ({ ok: true, time: new Date().toISOString() }));
  registerAuthRoutes(r, db);
  registerListingRoutes(r, db);
  registerThreadRoutes(r, db);
  registerTransactionRoutes(r, db);
  registerAdminRoutes(r, db);
  const server = serve(r, { authenticate: makeAuth(db), logger });
  const stop = scheduler ? startScheduler(db, 60e3, logger) : () => {};
  return { server, db, close: () => new Promise(res => { stop(); server.close(() => { db.raw.close(); res(); }); }) };
}
