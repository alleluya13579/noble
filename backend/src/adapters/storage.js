// Object storage for photos (public via signed URL) and ownership documents (encrypted at rest).
// Local disk by default; S3-compatible (AWS S3, Cloudflare R2, MinIO) when S3_* is configured.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

const key = () => Buffer.from(config.docsKey, 'hex');
export function encrypt(bytes) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key(), iv); const enc = Buffer.concat([c.update(bytes), c.final()]); return Buffer.concat([iv, c.getAuthTag(), enc]); }
export function decrypt(blob) { const iv = blob.subarray(0, 12), tag = blob.subarray(12, 28), enc = blob.subarray(28); const d = crypto.createDecipheriv('aes-256-gcm', key(), iv); d.setAuthTag(tag); return Buffer.concat([d.update(enc), d.final()]); }

export function localStorage(root = config.uploadDir) {
  fs.mkdirSync(root, { recursive: true });
  return {
    id: 'local', live: false,
    async put(objectKey, bytes) { const f = path.join(root, objectKey); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, bytes); return objectKey; },
    async get(objectKey) { return fs.readFileSync(path.join(root, objectKey)); },
    url(objectKey) { return `${config.baseUrl}/files/${objectKey}`; }
  };
}

/* S3-compatible, SigV4 signed with node:crypto (no SDK). */
export function s3Storage(c = config.storage.s3) {
  const host = new URL(c.endpoint).host;
  const sign = (method, objectKey, bytes, contentType) => {
    const now = new Date(), amz = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, ''), date = amz.slice(0, 8);
    const payloadHash = crypto.createHash('sha256').update(bytes || '').digest('hex');
    const headers = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amz, ...(contentType ? { 'content-type': contentType } : {}) };
    const signed = Object.keys(headers).sort().join(';');
    const canonical = [method, `/${c.bucket}/${objectKey}`, '', ...Object.keys(headers).sort().map(k => `${k}:${headers[k]}`), '', signed, payloadHash].join('\n');
    const scope = `${date}/${c.region}/s3/aws4_request`;
    const sts = ['AWS4-HMAC-SHA256', amz, scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
    const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
    const kSig = hmac(hmac(hmac(hmac('AWS4' + c.secret, date), c.region), 's3'), 'aws4_request');
    headers.Authorization = `AWS4-HMAC-SHA256 Credential=${c.key}/${scope}, SignedHeaders=${signed}, Signature=${crypto.createHmac('sha256', kSig).update(sts).digest('hex')}`;
    return headers;
  };
  return {
    id: 's3', live: true,
    async put(objectKey, bytes, contentType = 'application/octet-stream') { const r = await fetch(`${c.endpoint}/${c.bucket}/${objectKey}`, { method: 'PUT', headers: sign('PUT', objectKey, bytes, contentType), body: bytes }); if (!r.ok) throw new Error(`s3 put ${r.status}`); return objectKey; },
    async get(objectKey) { const r = await fetch(`${c.endpoint}/${c.bucket}/${objectKey}`, { headers: sign('GET', objectKey, '') }); if (!r.ok) throw new Error(`s3 get ${r.status}`); return Buffer.from(await r.arrayBuffer()); },
    url(objectKey) { return `${config.baseUrl}/files/${objectKey}`; } // served through the API so access rules apply
  };
}

export function storage() { return config.storage.s3.configured ? s3Storage() : localStorage(); }
