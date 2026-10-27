// A very small HTTP router over node:http. JSON in, JSON out, typed errors, bearer auth hook.
import http from 'node:http';

export class HttpError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
export const bad = (m, extra) => new HttpError(400, 'bad_request', m, extra);
export const unauth = (m = 'sign in first') => new HttpError(401, 'unauthenticated', m);
export const forbidden = (m = 'not allowed') => new HttpError(403, 'forbidden', m);
export const notFound = (m = 'not found') => new HttpError(404, 'not_found', m);
export const conflict = (m) => new HttpError(409, 'conflict', m);
export const tooMany = (m = 'too many requests') => new HttpError(429, 'rate_limited', m);

export function createRouter() {
  const routes = [];
  const add = (method, pattern, ...handlers) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handlers });
  };
  const api = { get: (p, ...h) => add('GET', p, ...h), post: (p, ...h) => add('POST', p, ...h), put: (p, ...h) => add('PUT', p, ...h), delete: (p, ...h) => add('DELETE', p, ...h), routes };
  return api;
}

export async function readBody(req, limit = 10 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new HttpError(413, 'too_large', 'body too large'); chunks.push(c); }
  return Buffer.concat(chunks);
}

/**
 * Serve a router. `authenticate(req)` returns the user or null. Handlers get (ctx) with
 * { req, res, params, query, body (parsed JSON), raw (Buffer), user, ip } and return a value
 * (sent as JSON, 200) or [status, value].
 */
export function serve(router, { authenticate, logger = console } = {}) {
  return http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    try {
      let match = null, params = {};
      for (const r of router.routes) {
        const m = r.re.exec(url.pathname);
        if (m && r.method === req.method) { match = r; r.keys.forEach((k, i) => params[k] = decodeURIComponent(m[i + 1])); break; }
      }
      if (!match) throw notFound(`no route for ${req.method} ${url.pathname}`);
      const raw = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : Buffer.alloc(0);
      const ct = req.headers['content-type'] || '';
      let body = {};
      if (raw.length && ct.includes('application/json')) { try { body = JSON.parse(raw.toString('utf8')); } catch { throw bad('invalid JSON body'); } }
      const ctx = { req, res, params, query: Object.fromEntries(url.searchParams), body, raw, contentType: ct, ip: req.socket.remoteAddress, user: authenticate ? await authenticate(req) : null };
      let out;
      for (const h of match.handlers) { out = await h(ctx); if (out !== undefined) break; }
      const [status, value] = Array.isArray(out) && typeof out[0] === 'number' ? out : [out === undefined ? 204 : 200, out];
      if (value && value.__file) { res.writeHead(status, { 'Content-Type': value.contentType }); return res.end(value.bytes); }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(value === undefined ? '' : JSON.stringify(value));
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) logger.error(e);
      res.writeHead(status, { 'Content-Type': 'application/json', ...(status === 429 ? { 'Retry-After': '60' } : {}) });
      res.end(JSON.stringify({ code: e.code || 'internal', message: status >= 500 ? 'internal error' : e.message, ...(e.extra || {}) }));
    } finally {
      logger.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });
}
