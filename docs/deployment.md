# Deployment

## Requirements
Docker Engine 24+ with Compose v2, 2 vCPU / 4 GB RAM minimum, a DNS name and a TLS certificate.

## First deployment
```bash
cp .env.example .env            # set POSTGRES_PASSWORD, DJANGO_SECRET_KEY (50+ random chars), PUBLIC_URL, HTTP_PORT
docker compose up -d --build    # db → backend (runs migrations, then Gunicorn) → frontend (Nginx)
docker compose ps               # all services healthy
curl -s http://localhost:8080/health/ready/   # {"status": "ok", "database": "up"}
docker compose exec backend python manage.py create_organization \
    --name "Your Company Pvt. Ltd." --code yourco --admin-email admin@yourco.com --admin-name "Administrator"
docker compose exec backend python manage.py createsuperuser   # optional platform Super Admin
```
Then sign in, open **Administration → Fiscal years**, create the current fiscal year (quick-fill: Nepali fiscal
year) and activate it, review **Company settings**, **Document numbering**, tax rates, payment methods and
warehouses, and post opening balances.

Demo data instead: `docker compose exec backend python manage.py seed_demo` (sign in as `admin@demo.erp` /
`Demo@12345`; other roles: manager@, sales@, purchase@, warehouse@, accounts@, auditor@demo.erp).

## HTTPS
Terminate TLS in front of the `frontend` container (a host Nginx/Caddy/Traefik or a cloud load balancer) and
forward to `HTTP_PORT`. Then set in `.env`:
```
PUBLIC_URL=https://erp.example.com
DJANGO_ALLOWED_HOSTS=erp.example.com,backend
DJANGO_SECURE_PROXY_SSL=1
DJANGO_HSTS_SECONDS=31536000
REFRESH_COOKIE_SECURE=1
```
and `docker compose up -d`. The proxy must pass `X-Forwarded-Proto: https`.

## Configuration reference
| Variable | Purpose |
| --- | --- |
| `DJANGO_SECRET_KEY` | Signing key for JWTs and sessions. Never reuse between environments. |
| `DATABASE_URL` | PostgreSQL URL (compose builds it from `POSTGRES_*`). |
| `JWT_ACCESS_MINUTES` / `JWT_REFRESH_DAYS` | Token lifetimes (15 min / 7 days; refresh tokens rotate and are blacklisted after use). |
| `THROTTLE_AUTH`, `THROTTLE_PASSWORD_RESET`, `THROTTLE_USER` | Rate limits (20/min, 5/hour, 10000/hour). |
| `EMAIL_BACKEND`, `DEFAULT_FROM_EMAIL` | SMTP settings for password-reset email (`django.core.mail.backends.smtp.EmailBackend` + `EMAIL_HOST` etc.). |
| `LOG_LEVEL`, `LOG_FORMAT` | Logs go to stdout as JSON (with request IDs) when DEBUG is off. |
| `GUNICORN_WORKERS` | Typically 2 × CPU + 1. |
| `MAX_ATTACHMENT_SIZE` | Bytes, default 5 MB. |

## Operations
* Health: `/healthz` (Nginx), `/health/` (Django process), `/health/ready/` (database). Container health checks use them.
* Logs: `docker compose logs -f backend` – one JSON object per line with `request_id`; the same ID is returned in
  the `X-Request-ID` response header and stored on audit events.
* Upgrades: `git pull && docker compose up -d --build` (migrations run on start). Take a backup first.
* API documentation: `/api/docs/` (Swagger UI) and `/api/schema/` (OpenAPI 3).
* Static files are collected into the image and served by WhiteNoise; uploaded media lives in the `media` volume
  and is only served through authenticated API endpoints.

## Local development (without Docker for the app)
```bash
docker run -d --name erp-dev-db -e POSTGRES_USER=erp -e POSTGRES_PASSWORD=erp -e POSTGRES_DB=erp -p 5433:5432 postgres:16-alpine
cd backend && uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r requirements-dev.txt
cp .env.example .env && set -a && . ./.env && set +a
.venv/bin/python manage.py migrate && .venv/bin/python manage.py seed_demo && .venv/bin/python manage.py runserver
cd ../frontend && npm ci && npm run dev    # http://localhost:5173 (proxies /api to :8000)
```
