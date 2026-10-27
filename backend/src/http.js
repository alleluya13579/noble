// A very small HTTP router over node:http. JSON in, JSON out, typed errors, bearer auth hook,
// security headers, configurable CORS, request ids, per-IP rate limiting and metrics hooks.
import http from 'node:http';
import crypto from 'node:crypto';

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
    routes.push({ method, pattern, re, keys, handlers });
  };
  return { get: (p, ...h) => add('GET', p, ...h), post: (p, ...h) => add('POST', p, ...h), put: (p, ...h) => add('PUT', p, ...h), delete: (p, ...h) => add('DELETE', p, ...h), routes };
}

export async function readBody(req, limit) {
  const declared = +(req.headers['content-length'] || 0);
  if (declared > limit) throw new HttpError(413, 'too_large', `body larger than ${limit} bytes`);
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new HttpError(413, 'too_large', `body larger than ${limit} bytes`); chunks.push(c); }
  return Buffer.concat(chunks);
}

/** Sliding-window per-key limiter kept in memory (per process). Fine behind a load balancer as a first line; the DB limiter covers business rules. */
export function memoryLimiter({ limit, windowMs }) {
  const hits = new Map();
  setInterval(() => { const cut = Date.now() - windowMs; for (const [k, arr] of hits) { const kept = arr.filter(t => t > cut); if (kept.length) hits.set(k, kept); else hits.delete(k); } }, windowMs).unref();
  return key => { const now = Date.now(), arr = (hits.get(key) || []).filter(t => t > now - windowMs); if (arr.length >= limit) return false; arr.push(now); hits.set(key, arr); return true; };
}

/** Prometheus-style counters and a latency histogram, rendered by /metrics. */
export function createMetrics() {
  const counters = new Map(), buckets = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000], hist = new Map();
  const inc = (name, labels = {}, by = 1) => { const k = name + JSON.stringify(labels); counters.set(k, { name, labels, value: (counters.get(k)?.value || 0) + by }); };
  const observe = (route, ms) => { const h = hist.get(route) || { count: 0, sum: 0, le: new Array(buckets.length).fill(0) }; h.count++; h.sum += ms; buckets.forEach((b, i) => { if (ms <= b) h.le[i]++; }); hist.set(route, h); };
  const fmt = l => Object.entries(l).map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`).join(',');
  const render = (extra = []) => {
    const out = ['# TYPE noble_http_requests_total counter'];
    for (const c of counters.values()) out.push(`${c.name}{${fmt(c.labels)}} ${c.value}`);
    out.push('# TYPE noble_http_request_duration_ms histogram');
    for (const [route, h] of hist) { buckets.forEach((b, i) => out.push(`noble_http_request_duration_ms_bucket{route="${route}",le="${b}"} ${h.le[i]}`)); out.push(`noble_http_request_duration_ms_bucket{route="${route}",le="+Inf"} ${h.count}`, `noble_http_request_duration_ms_sum{route="${route}"} ${h.sum}`, `noble_http_request_duration_ms_count{route="${route}"} ${h.count}`); }
    return out.concat(extra).join('\n') + '\n';
  };
  return { inc, observe, render };
}

/**
 * Serve a router. Options: authenticate(req) -> user|null, logger, corsOrigins (['*'] or list),
 * trustProxy (read X-Forwarded-For), bodyLimit, limiter(key) -> bool, metrics, csp (string for HTML pages).
 * Handlers get ctx = { req, res, params, query, body, raw, contentType, ip, user, requestId }
 * and return a value (JSON, 200), [status, value], or {__file, contentType, bytes}.
 */
export function serve(router, { authenticate, logger = console, corsOrigins = ['*'], trustProxy = false, bodyLimit = 10 * 1024 * 1024, limiter, metrics, csp } = {}) {
  const json = logger.json === true;
  return http.createServer(async (req, res) => {
    const started = Date.now(), requestId = req.headers['x-request-id'] && /^[\w.-]{1,64}$/.test(req.headers['x-request-id']) ? req.headers['x-request-id'] : crypto.randomUUID();
    const url = new URL(req.url, 'http://x');
    const ip = (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (trustProxy || req.socket.encrypted) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    const origin = req.headers.origin;
    if (origin && (corsOrigins.includes('*') || corsOrigins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigins.includes('*') ? '*' : origin); res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, X-Request-Id, X-Document-Kind');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS'); res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    let route = 'unmatched';
    try {
      if (limiter && !limiter(ip)) throw tooMany('too many requests from this address');
      let match = null, params = {};
      for (const r of router.routes) {
        const m = r.re.exec(url.pathname);
        if (m && r.method === req.method) { match = r; route = `${r.method} ${r.pattern}`; r.keys.forEach((k, i) => params[k] = decodeURIComponent(m[i + 1])); break; }
      }
      if (!match) throw notFound(`no route for ${req.method} ${url.pathname}`);
      const raw = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req, bodyLimit) : Buffer.alloc(0);
      const ct = req.headers['content-type'] || '';
      let body = {};
      if (raw.length && ct.includes('application/json')) { try { body = JSON.parse(raw.toString('utf8')); } catch { throw bad('invalid JSON body'); } if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('JSON body must be an object'); }
      const ctx = { req, res, params, query: Object.fromEntries(url.searchParams), body, raw, contentType: ct, ip, requestId, user: authenticate ? await authenticate(req) : null };
      let out;
      for (const h of match.handlers) { out = await h(ctx); if (out !== undefined) break; }
      const [status, value] = Array.isArray(out) && typeof out[0] === 'number' ? out : [out === undefined ? 204 : 200, out];
      if (value && value.__file) {
        const headers = { 'Content-Type': value.contentType, 'Cache-Control': value.cache || 'no-store' };
        if (csp && /text\/html/.test(value.contentType)) headers['Content-Security-Policy'] = csp;
        res.writeHead(status, headers); return res.end(value.bytes);
      }
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(value === undefined ? '' : JSON.stringify(value));
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) logger.error(json ? JSON.stringify({ level: 'error', requestId, route, message: e.message, stack: e.stack }) : e);
      if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json', ...(status === 429 ? { 'Retry-After': '60' } : {}) });
      res.end(JSON.stringify({ code: e.code || 'internal', message: status >= 500 ? 'internal error' : e.message, request_id: requestId, ...(e.extra || {}) }));
    } finally {
      const ms = Date.now() - started;
      if (metrics) { metrics.inc('noble_http_requests_total', { route, status: res.statusCode }); metrics.observe(route, ms); }
      logger.log(json ? JSON.stringify({ level: 'info', time: new Date().toISOString(), requestId, method: req.method, path: url.pathname, route, status: res.statusCode, ms, ip }) : `${req.method} ${url.pathname} ${res.statusCode} ${ms}ms`);
    }
  });
}
