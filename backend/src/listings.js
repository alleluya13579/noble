// Listings: search, create (goes to the moderation queue), lifecycle, photos, ownership documents, saves, reports.
import crypto from 'node:crypto';
import { bad, forbidden, notFound, conflict, tooMany } from './http.js';
import { requireUser, requireVerified, publicUser } from './auth.js';
import { storage, encrypt, decrypt } from './adapters/storage.js';
import { mapsFor } from './adapters/maps.js';

const TYPES = ['sale', 'rent', 'land'], UNITS = ['sqm', 'sqft', 'acres', 'hectares', 'plots'];
const haversineKm = (a, b, c, d) => { const R = 6371, dLat = (c - a) * Math.PI / 180, dLng = (d - b) * Math.PI / 180; const x = Math.sin(dLat / 2) ** 2 + Math.cos(a * Math.PI / 180) * Math.cos(c * Math.PI / 180) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };

export function listingView(db, l, viewer) {
  const owner = db.get('SELECT * FROM users WHERE id = ?', l.owner_id);
  const photos = db.all('SELECT id, object_key, position FROM listing_photos WHERE listing_id = ? ORDER BY position', l.id).map(p => ({ id: p.id, url: storage().url(p.object_key) }));
  const docs = db.all('SELECT kind, checks, checked_at FROM ownership_documents WHERE listing_id = ?', l.id);
  const isOwner = viewer && viewer.id === l.owner_id, isAdmin = viewer && viewer.role === 'admin';
  const heldByViewer = viewer && db.get("SELECT 1 FROM transactions WHERE listing_id = ? AND buyer_id = ? AND state IN ('held','viewing_confirmed','released')", l.id, viewer.id);
  const stats = isOwner || isAdmin ? { views: l.view_count, saves: db.get('SELECT COUNT(*) n FROM saved_listings WHERE listing_id = ?', l.id).n, enquiries: db.get('SELECT COUNT(*) n FROM threads WHERE listing_id = ?', l.id).n, offers: db.get("SELECT COUNT(*) n FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.listing_id = ? AND m.kind = 'offer'", l.id).n } : { views: l.view_count };
  return { id: l.id, country: l.country_code, type: l.type, title: l.title, description: l.description, price_minor: l.price_minor, currency: l.currency, lat: l.lat, lng: l.lng, place_name: l.place_name,
    address_private: isOwner || isAdmin || heldByViewer ? l.address_private : undefined, size: l.size, size_unit: l.size_unit, bedrooms: l.bedrooms, title_status: l.title_status, status: l.status, reject_reason: isOwner || isAdmin ? l.reject_reason : undefined,
    client_owner_name: l.client_owner_name, photos, ownership_verified: docs.some(d => d.checked_at), documents: isOwner || isAdmin ? docs.map(d => ({ kind: d.kind, checks: JSON.parse(d.checks), checked_at: d.checked_at })) : undefined,
    owner: publicUser(db, owner), stats, saved: viewer ? !!db.get('SELECT 1 FROM saved_listings WHERE user_id = ? AND listing_id = ?', viewer.id, l.id) : false, created_at: new Date(l.created_at).toISOString(), closed_at: l.closed_at ? new Date(l.closed_at).toISOString() : null };
}

export function registerListingRoutes(r, db) {
  const store = storage();

  r.get('/listings', ctx => {
    const q = ctx.query, country = String(q.country || '').toUpperCase();
    if (!db.country(country)) throw bad('country (ISO code) is required');
    const where = ['country_code = ?', "status = 'approved'"], p = [country];
    if (q.type) { if (!TYPES.includes(q.type)) throw bad('type must be sale, rent or land'); where.push('type = ?'); p.push(q.type); }
    if (q.q) { where.push("(lower(title) LIKE ? OR lower(place_name) LIKE ? OR lower(title_status) LIKE ?)"); const like = `%${String(q.q).toLowerCase()}%`; p.push(like, like, like); }
    if (q.min_price) { where.push('price_minor >= ?'); p.push(+q.min_price); }
    if (q.max_price) { where.push('price_minor <= ?'); p.push(+q.max_price); }
    if (q.beds) { where.push('bedrooms >= ?'); p.push(+q.beds); }
    if (q.saved === 'true' && ctx.user) { where.push('id IN (SELECT listing_id FROM saved_listings WHERE user_id = ?)'); p.push(ctx.user.id); }
    const order = { newest: 'created_at DESC', price_asc: 'price_minor ASC', price_desc: 'price_minor DESC', popular: 'view_count DESC' }[q.sort] || 'created_at DESC';
    let rows = db.all(`SELECT * FROM listings WHERE ${where.join(' AND ')} ORDER BY ${order}`, ...p);
    if (q.near) { const [lat, lng] = String(q.near).split(',').map(Number), radius = +(q.radius_km || 10); if (Number.isFinite(lat) && Number.isFinite(lng)) rows = rows.filter(l => haversineKm(lat, lng, l.lat, l.lng) <= radius); }
    const offset = +(q.cursor || 0), page = rows.slice(offset, offset + 20);
    return { items: page.map(l => listingView(db, l, ctx.user)), total: rows.length, next_cursor: offset + 20 < rows.length ? String(offset + 20) : null };
  });

  r.get('/listings/mine', ctx => { const u = requireUser(ctx); return db.all('SELECT * FROM listings WHERE owner_id = ? ORDER BY created_at DESC', u.id).map(l => listingView(db, l, u)); });

  r.get('/listings/:id', ctx => {
    const l = db.get('SELECT * FROM listings WHERE id = ?', ctx.params.id); if (!l) throw notFound('listing not found');
    const isOwner = ctx.user && ctx.user.id === l.owner_id, isAdmin = ctx.user && ctx.user.role === 'admin';
    if (!['approved', 'paused', 'closed'].includes(l.status) && !isOwner && !isAdmin) throw notFound('listing not found');
    if (!isOwner && !isAdmin) db.run('UPDATE listings SET view_count = view_count + 1 WHERE id = ?', l.id);
    return listingView(db, db.get('SELECT * FROM listings WHERE id = ?', l.id), ctx.user);
  });

  r.post('/listings', async ctx => {
    const u = requireVerified(ctx);
    if (!['seller', 'agent'].includes(u.role)) throw forbidden('only sellers, landlords and agents can list');
    if (!db.allow(u.id, 'listings_24h', 3, 86400e3)) throw tooMany('3 listings per 24 hours per account');
    const b = ctx.body, country = db.country(u.country_code);
    if (!TYPES.includes(b.type)) throw bad('type must be sale, rent or land');
    const title = String(b.title || '').trim(); if (title.length < 5 || title.length > 120) throw bad('title must be 5 to 120 characters');
    const price = Math.round(+b.price_minor); if (!(price > 0)) throw bad('price_minor must be a positive integer (minor units)');
    if (!UNITS.includes(b.size_unit)) throw bad(`size_unit must be one of ${UNITS.join(', ')}`);
    if (!(+b.size > 0)) throw bad('size must be positive');
    if (!b.title_status) throw bad('title_status is required');
    if (u.role === 'agent' && !String(b.client_owner_name || '').trim()) throw bad('agents must name the registered owner (client_owner_name)');
    let lat = +b.lat, lng = +b.lng, place = String(b.place_name || '').trim();
    const maps = mapsFor(db);
    if (!(Number.isFinite(lat) && Number.isFinite(lng))) { if (!b.address) throw bad('lat and lng, or an address to geocode, are required'); const hits = await maps.geocode(String(b.address), u.country_code); if (!hits.length) throw bad('address could not be geocoded'); ({ lat, lng } = hits[0]); place = place || hits[0].label; }
    if (!place) place = (await maps.reverse(lat, lng, u.country_code)).placeName;
    const id = db.uuid();
    db.run('INSERT INTO listings (id, country_code, owner_id, client_owner_name, type, title, description, price_minor, currency, lat, lng, place_name, address_private, size, size_unit, bedrooms, title_status, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, u.country_code, u.id, b.client_owner_name || null, b.type, title, String(b.description || '').slice(0, 5000) || null, price, b.currency || country.currency, lat, lng, place, b.address_private || null, +b.size, b.size_unit, Math.max(0, +b.bedrooms || 0), String(b.title_status), 'pending', Date.now());
    db.audit(u.id, 'listing_submitted', 'listing', id, { type: b.type }, ctx.ip);
    return [201, listingView(db, db.get('SELECT * FROM listings WHERE id = ?', id), u)];
  });

  r.post('/listings/:id/status', ctx => {
    const u = requireUser(ctx), l = own(db, ctx, u);
    const a = ctx.body.action, moves = { pause: ['approved', 'paused'], resume: ['paused', 'approved'], close: ['approved', 'closed'], relist: ['closed|rejected|removed|paused', 'pending'] }[a];
    if (!moves) throw bad('action must be pause, resume, close or relist');
    if (!moves[0].split('|').includes(l.status)) throw conflict(`cannot ${a} a listing that is ${l.status}`);
    if (a === 'relist' && !db.allow(u.id, 'listings_24h', 3, 86400e3)) throw tooMany('3 listings per 24 hours per account');
    db.run('UPDATE listings SET status = ?, closed_at = ?, reject_reason = NULL, reviewed_by = NULL, reviewed_at = NULL, created_at = CASE WHEN ? = ? THEN ? ELSE created_at END WHERE id = ?', moves[1], a === 'close' ? Date.now() : null, a, 'relist', Date.now(), l.id);
    if (a === 'relist') db.run("UPDATE ownership_documents SET checks = '{}', checked_by = NULL, checked_at = NULL WHERE listing_id = ?", l.id);
    db.audit(u.id, 'listing_' + a, 'listing', l.id, {}, ctx.ip);
    return listingView(db, db.get('SELECT * FROM listings WHERE id = ?', l.id), u);
  });

  // Photos: raw image bytes with an image/* content type. The server stores them and records a
  // content hash; exact duplicates across listings are flagged. Near-duplicate (perceptual) hashing
  // needs an image decoder: plug one in at `perceptualHash` below (e.g. sharp + blockhash).
  r.post('/listings/:id/photos', async ctx => {
    const u = requireUser(ctx), l = own(db, ctx, u);
    if (!ctx.contentType.startsWith('image/') || !ctx.raw.length) throw bad('send the image bytes with an image/* content type');
    if (db.get('SELECT COUNT(*) n FROM listing_photos WHERE listing_id = ?', l.id).n >= 12) throw conflict('up to 12 photos per listing');
    const hash = crypto.createHash('sha256').update(ctx.raw).digest('hex');
    const id = db.uuid(), key = `photos/${l.id}/${id}.${ctx.contentType.split('/')[1].replace(/[^a-z0-9]/g, '') || 'bin'}`;
    await store.put(key, ctx.raw, ctx.contentType);
    db.run('INSERT INTO listing_photos (id, listing_id, object_key, content_type, content_hash, perceptual_hash, position) VALUES (?,?,?,?,?,?,?)', id, l.id, key, ctx.contentType, hash, await perceptualHash(ctx.raw), db.get('SELECT COUNT(*) n FROM listing_photos WHERE listing_id = ?', l.id).n);
    const dupes = db.all('SELECT DISTINCT listing_id FROM listing_photos WHERE content_hash = ? AND listing_id <> ?', hash, l.id).map(x => x.listing_id);
    if (dupes.length) db.audit(u.id, 'photo_duplicate', 'listing', l.id, { matches: dupes });
    return [201, { id, url: store.url(key), duplicate_of: dupes }];
  });

  r.post('/listings/:id/documents', async ctx => {
    const u = requireUser(ctx), l = own(db, ctx, u);
    const kind = ctx.query.kind || ctx.req.headers['x-document-kind'];
    if (!['title_deed', 'registry_search', 'lease_authority', 'allotment_letter'].includes(kind)) throw bad('kind must be title_deed, registry_search, lease_authority or allotment_letter (query ?kind=)');
    if (!ctx.raw.length) throw bad('send the document bytes (PDF or image)');
    const id = db.uuid(), key = `documents/${l.id}/${id}.enc`;
    await store.put(key, encrypt(ctx.raw), 'application/octet-stream');
    db.run('INSERT INTO ownership_documents (id, listing_id, kind, object_key, created_at) VALUES (?,?,?,?,?)', id, l.id, kind, key, Date.now());
    db.audit(u.id, 'document_uploaded', 'listing', l.id, { kind }, ctx.ip);
    return [201, { id, kind }];
  });
  r.get('/listings/:id/documents/:doc', async ctx => {
    const u = requireUser(ctx); const l = db.get('SELECT * FROM listings WHERE id = ?', ctx.params.id); if (!l) throw notFound();
    if (u.role !== 'admin' && u.id !== l.owner_id) throw forbidden('documents are visible to the owner and admins only');
    const d = db.get('SELECT * FROM ownership_documents WHERE id = ? AND listing_id = ?', ctx.params.doc, l.id); if (!d) throw notFound();
    db.audit(u.id, 'document_viewed', 'listing', l.id, { doc: d.id }, ctx.ip);
    return { __file: true, contentType: 'application/octet-stream', bytes: decrypt(await store.get(d.object_key)) };
  });

  r.get('/files/photos/:listing/:name', async ctx => { const p = db.get('SELECT * FROM listing_photos WHERE object_key = ?', `photos/${ctx.params.listing}/${ctx.params.name}`); if (!p) throw notFound(); return { __file: true, contentType: p.content_type, bytes: await store.get(p.object_key) }; });

  r.put('/listings/:id/save', ctx => { const u = requireVerified(ctx); exists(db, ctx.params.id); db.run('INSERT OR IGNORE INTO saved_listings (user_id, listing_id, created_at) VALUES (?,?,?)', u.id, ctx.params.id, Date.now()); return [204]; });
  r.delete('/listings/:id/save', ctx => { const u = requireUser(ctx); db.run('DELETE FROM saved_listings WHERE user_id = ? AND listing_id = ?', u.id, ctx.params.id); return [204]; });

  r.post('/listings/:id/report', ctx => {
    const u = requireVerified(ctx), l = exists(db, ctx.params.id);
    if (!db.allow(u.id, 'reports_24h', 10, 86400e3)) throw tooMany('too many reports today');
    const reason = String(ctx.body.reason || '').trim(); if (reason.length < 5) throw bad('reason is required');
    const id = db.uuid();
    db.run('INSERT INTO reports (id, listing_id, reporter_id, reason, details, status, created_at) VALUES (?,?,?,?,?,?,?)', id, l.id, u.id, reason, String(ctx.body.details || '').slice(0, 2000) || null, 'open', Date.now());
    return [202, { id }];
  });
}

function own(db, ctx, u) { const l = db.get('SELECT * FROM listings WHERE id = ?', ctx.params.id); if (!l) throw notFound('listing not found'); if (l.owner_id !== u.id && u.role !== 'admin') throw forbidden('not your listing'); return l; }
function exists(db, id) { const l = db.get('SELECT * FROM listings WHERE id = ?', id); if (!l) throw notFound('listing not found'); return l; }
/** Slot for a perceptual hash (pHash/blockhash). Returns null until an image decoder is wired in. */
async function perceptualHash(bytes) { return null; }
