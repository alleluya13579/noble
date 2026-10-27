# Deploying Noble

One container runs the API, the web app and the scheduler. It needs PostgreSQL, a persistent volume or S3 for uploads, TLS in front, and the provider keys for the countries you launch in. Everything below is in the repo.

## 1. Choose a host

| Host | How |
| --- | --- |
| **Docker anywhere** (VPS, on-prem) | `docker compose up -d` (API + Postgres + volumes). Put Caddy or nginx in front for TLS. |
| **Fly.io** | `fly launch --dockerfile backend/Dockerfile`, `fly postgres create`, `fly secrets set …` from the checklist below. |
| **Railway / Render** | New service from this repo, Dockerfile path `backend/Dockerfile`, add a PostgreSQL plugin, set env vars. |
| **Kubernetes** | Build the image, one Deployment (2+ replicas are fine: the scheduler takes a Postgres advisory lock so only one instance runs it), readiness probe `GET /ready`, liveness `GET /health`. |

## 2. Secrets and settings checklist

The server refuses to start with `NOBLE_ENV=production` until these are right:

```
NOBLE_ENV=production
PUBLIC_BASE_URL=https://api.noble.example          # providers call webhooks here
CORS_ORIGINS=https://app.noble.example             # where the web app is served (same host is fine)
SESSION_SECRET=$(openssl rand -hex 32)
ID_HASH_SECRET=$(openssl rand -hex 32)
DOCS_ENCRYPTION_KEY=$(openssl rand -hex 32)        # keep forever: documents are unreadable without it
ADMIN_PHONES=+254700000000,+447700900000
DATABASE_URL=postgres://noble:…@host:5432/noble
TRUST_PROXY=true                                   # behind a load balancer / Caddy / nginx
LOG_FORMAT=json
S3_ENDPOINT=… S3_BUCKET=… S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=…   # or a persistent UPLOAD_DIR volume
METRICS_TOKEN=$(openssl rand -hex 16)              # protects GET /metrics
```

Then the provider keys for your launch countries (see `backend/.env.example`). Each provider stays in sandbox until its keys are present; `GET /admin/integrations` and the startup log show the state.

## 3. TLS and the reverse proxy

Minimal Caddyfile (automatic Let's Encrypt certificates):

```
api.noble.example {
    reverse_proxy localhost:8080
}
```

With nginx, forward `X-Forwarded-For` and set `TRUST_PROXY=true`. The API sets HSTS, `X-Content-Type-Options`, `X-Frame-Options`, a Content-Security-Policy on the web app, and `no-store` on API responses.

## 4. Webhooks

Register these URLs with each provider's dashboard (the API also passes per-transaction callback URLs that include an unguessable secret):

| Provider | URL |
| --- | --- |
| M-Pesa Daraja | per-transaction `CallBackURL` is sent with each STK push; no dashboard URL needed |
| Paystack | `https://api.noble.example/webhooks/payments/paystack` |
| Flutterwave | `https://api.noble.example/webhooks/payments/flutterwave` (set `FLUTTERWAVE_WEBHOOK_HASH` to the same secret hash) |
| Stripe | `https://api.noble.example/webhooks/payments/stripe` (events: `payment_intent.amount_capturable_updated`, `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded`, `transfer.created`) |
| Smile Identity | `https://api.noble.example/webhooks/kyc/smile_id` |
| Onfido | `https://api.noble.example/webhooks/kyc/onfido` (set `ONFIDO_WEBHOOK_TOKEN`) |

Every webhook is signature-verified by its adapter; M-Pesa callbacks (unsigned by design) are re-queried before funds count as held.

## 5. Database

- PostgreSQL 14+. `backend/schema.sql` is applied on start; later changes go in `backend/migrations/NNN_name.sql` and run once each (tracked in `schema_migrations`).
- Back up with `pg_dump`; restore with `psql`. Test a restore before launch.
- Connection pool is 10 per instance; size the database accordingly.
- At scale, enable PostGIS for radius search (instructions at the top of `schema.sql`).

## 6. Observability

- `GET /health`: process alive. `GET /ready`: database reachable (use for load-balancer checks).
- `GET /metrics`: Prometheus format (request counts and latency per route, transactions by state, pending listings). Protect with `METRICS_TOKEN`.
- `LOG_FORMAT=json`: one line per request with `requestId`, route, status, latency and client IP. Send `X-Request-Id` from the client to correlate.
- Audit log in the database (`audit_log`) for every moderation and money decision; `payment_events` is the append-only gateway ledger.

## 7. Launch checklist per country

1. Provider sandbox keys → run the real flow end to end against the provider sandboxes.
2. Escrow legal basis: a licensed escrow/trust partner or your own licence (holding client money is regulated).
3. Data-protection registration (e.g. Kenya ODPC, Nigeria NDPC, UK ICO) and a published privacy policy.
4. Admin accounts (`ADMIN_PHONES`) with real phones; moderation rota agreed.
5. Switch provider keys to production; confirm `GET /admin/integrations` shows `live`.
6. Set `rent_deposit_months`, `commission_pct`, `viewing_days`, `handover_days` for the country in the `countries` table if they differ from the defaults.

## 8. Upgrades

`docker compose pull && docker compose up -d` (or your platform's deploy). Migrations run on start; the scheduler lock prevents double runs during a rolling deploy. Roll back by deploying the previous image; migrations are additive.
