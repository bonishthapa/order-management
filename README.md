# Trade ERP – B2B order management, inventory and accounting

A complete, connected ERP for wholesale, distribution and trading businesses in Nepal: sales and purchases from
order to settlement, multi-warehouse FIFO inventory, double-entry accounting, configurable fiscal years with
period locking and a guided year-end close, and AD/BS (Bikram Sambat) dates throughout.

**Stack:** Django 5.2 · Django REST Framework · PostgreSQL 16 · React 18 + TypeScript · Vite · Tailwind ·
TanStack Query · AG Grid Community · WeasyPrint PDFs · Docker Compose (Nginx + Gunicorn).

## Quick start (Docker)
```bash
cp .env.example .env                 # set POSTGRES_PASSWORD and DJANGO_SECRET_KEY
docker compose up -d --build
docker compose exec backend python manage.py seed_demo
open http://localhost:8080           # admin@demo.erp / Demo@12345
```
Other demo users (same password): `manager@`, `sales@`, `purchase@`, `warehouse@`, `accounts@`, `auditor@demo.erp`.
For a real company use `python manage.py create_organization …` instead of `seed_demo`
(see [docs/deployment.md](docs/deployment.md)).

## Local development
```bash
docker run -d --name erp-dev-db -e POSTGRES_USER=erp -e POSTGRES_PASSWORD=erp -e POSTGRES_DB=erp -p 5433:5432 postgres:16-alpine
cd backend
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r requirements-dev.txt
DJANGO_DEBUG=1 .venv/bin/python manage.py migrate
DJANGO_DEBUG=1 .venv/bin/python manage.py seed_demo
DJANGO_DEBUG=1 .venv/bin/python manage.py runserver        # http://localhost:8000/api/docs/
cd ../frontend && npm ci && npm run dev                     # http://localhost:5173
```

## Tests
```bash
cd backend && .venv/bin/python -m pytest -q        # needs the PostgreSQL container above
cd frontend && npm test && npm run typecheck && npm run build
```
See [docs/testing.md](docs/testing.md).

## What is included
| Area | Highlights |
| --- | --- |
| Sales | Orders with approval, credit-limit check and stock reservation; partial deliveries and backorders; invoices from deliveries or direct; receipts allocated across invoices; advances, refunds, reversals; returns with inspection and credit notes |
| Purchases | Purchase orders with approval; goods received notes with accepted/rejected quantities, batches, expiry, serials; supplier bills with duplicate-invoice detection and price variance; payment vouchers (prepared → approved); debit notes |
| Inventory | Multiple warehouses and locations, FIFO cost layers, reservations, transfers through goods-in-transit, counts, adjustments, write-offs, batch/serial/expiry tracking, low-stock alerts, product import and bulk pricing |
| Accounting | Chart of accounts, automatic balanced journals for every posting, manual/opening journals, customer/supplier ledgers, statements and aging, cash and bank books, bank reconciliation, expenses with approval |
| Fiscal years | Configurable (default Nepali Shrawan–Ashadh), BS or AD monthly periods, period locking with audited reopening, fiscal-year-aware numbering (`SI-2083/84-000001`), year-end preview/close/reopen |
| Dates | Shared BS dataset for backend and frontend, dual-calendar picker, AD/BS/both display, BS range filters, both calendars on PDFs and exports |
| Reports | ~25 reports (sales, purchases, inventory valuation and movement, gross profit, P&L, balance sheet, trial balance, aging, VAT, cash/bank book, fiscal-year comparison, audit) with CSV/Excel/PDF |
| Control | Eight roles, server-side permissions, organisation isolation, warehouse restrictions, append-only audit trail with request IDs, connected-document timeline, attachments |

## Documentation
[Architecture](docs/architecture.md) · [Database schema](docs/database-schema.md) ·
[API](docs/api-documentation.md) · [Calendar and date rules](docs/calendar-and-date-rules.md) ·
[Fiscal years](docs/fiscal-year-management.md) · [Accounting rules](docs/accounting-rules.md) ·
[Business workflows](docs/business-workflows.md) · [Deployment](docs/deployment.md) ·
[Backup and restore](docs/backup-restore.md) · [Testing](docs/testing.md) ·
[Reference review](docs/reference-review.md) · [Implementation checklist](docs/implementation-checklist.md) ·
[Frontend conventions](frontend/CONVENTIONS.md)

## Scope notes
This is an operational accounting system. VAT handling follows the configured rates; confirm statutory and IRD
requirements (e.g. electronic billing rules) for your business before relying on it for tax filing.
