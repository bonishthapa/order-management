# Architecture

## Overview

```
Browser (React SPA)  ──HTTPS──>  Nginx  ──/api, /admin, /static, /health──>  Gunicorn + Django REST Framework  ──>  PostgreSQL 16
                                   └── serves the built SPA (same origin)
```

* **Same-origin deployment.** Nginx serves the SPA and proxies the API, so the refresh-token cookie can be
  `HttpOnly; SameSite=Strict` and production needs no CORS.
* **Backend is authoritative** for prices, discounts, taxes, totals, allocations, balances, stock, costing,
  numbering, fiscal-year assignment, period checks and permissions. The frontend sends inputs only.
* **Everything posts through services.** Views never write ledger or stock rows; they call domain services
  (`apps/*/services.py`) that run inside one database transaction.

## Backend (`backend/`)

| App | Responsibility |
| --- | --- |
| `core` | Base models, request-ID middleware, error envelope, permissions, organisation scoping, numbering, PDF/CSV/Excel helpers, attachments, global search, connected-document graph |
| `calendar_utils` | BS↔AD conversion (shared dataset), dual-date serializer mixin, date-range resolution |
| `organizations` | Organisation profile and settings, branches, taxes, units, payment methods, numbering policies, bootstrap and demo commands |
| `users` | Custom user (email login), memberships with role and warehouse/branch restrictions, role→permission matrix, JWT auth endpoints |
| `audit` | Append-only `AuditEvent` + `record_event()` |
| `fiscal_years` | Fiscal years, accounting periods, posting guard, period locking, year-end preview/close/reopen |
| `accounting` | Chart of accounts, journals (double entry), posting/reversal, ledgers, aging, opening balances, bank reconciliation |
| `customers`, `suppliers` | Parties; balances derived from the general ledger |
| `products` | Products/services, categories, brands, wholesale price tiers, import, bulk pricing |
| `inventory` | Warehouses, locations, stock ledger, balances, FIFO cost layers, batches, serials, reservations, transfers (via transit), counts |
| `sales` | Orders, deliveries, invoices, returns/credit notes |
| `purchases` | Purchase orders, goods received notes, supplier bills, returns/debit notes |
| `payments` | Customer receipts, payment vouchers, allocations, refunds |
| `expenses` | Expense categories and vouchers |
| `reports` | Report registry (≈25 reports) and dashboard |

### Request flow
1. `RequestIDMiddleware` assigns/propagates `X-Request-ID` (logged and stored on audit events).
2. JWT authentication (`Authorization: Bearer`), then `HasModulePermission` resolves the organisation from
   `X-Organization-ID` against active memberships and checks the action's permission.
3. Querysets are filtered by organisation (and by allowed warehouses where relevant). Relation fields in
   serializers use `OrgRelatedField`, so ids from another organisation are rejected as "does not exist".
4. Services post atomically; failures raise `BusinessRuleError` (HTTP 409 with a `code`) and roll back.

### Integrity guarantees
* Database constraints: unique document numbers per organisation, one active fiscal year, non-overlapping fiscal
  years (PostgreSQL exclusion constraint), positive quantities, one-sided journal lines, balanced posted journals
  (check constraint **and** a deferred constraint trigger), immutable posted journal lines (trigger), non-negative
  reservations/cost layers, over-delivery/over-invoicing/over-receipt/over-billing/over-return checks.
* Row locking: `select_for_update` on documents, stock balances, cost layers and allocations; numbering uses an
  atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING`; postings take `FOR SHARE` on the accounting period and
  fiscal year while closing takes `FOR UPDATE`.
* Idempotency: every system journal has a unique `idempotency_key` (`SI:42`, `PV:7`, …).

## Frontend (`frontend/`)
* React 18 + TypeScript + Vite, Tailwind with a small token set, Radix primitives, TanStack Query, React Hook Form
  + Zod, AG Grid Community (server-side pagination/sorting via our own pager), Recharts.
* `src/api` – axios client (in-memory access token, single-flight refresh), query hooks.
* `src/calendar` – the same BS dataset and algorithm as the backend; `DatePicker` (dual AD/BS) and `DateText`.
* `src/components` – UI kit, data grid, document components (line editor, totals, timeline, attachments,
  allocation table, print).
* `src/features/<area>` – screens. See `frontend/CONVENTIONS.md`.

## Reference research
See `reference-review.md` for what could and could not be inspected on the three reference products.
