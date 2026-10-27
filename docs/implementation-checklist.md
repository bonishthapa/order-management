# Implementation checklist

Status as of 27 Oct 2026. ✅ done and tested · 🟡 done with a documented limitation.

## Phase 1 – Foundation
- ✅ Repository layout, Docker (backend, frontend/Nginx, PostgreSQL), environment configuration, health checks
- ✅ Django settings, JSON logging with request IDs, error envelope, OpenAPI docs (`/api/docs/`)
- ✅ JWT auth (in-memory access token, rotating HttpOnly refresh cookie, blacklist), password change/reset, throttling
- ✅ Organisations, memberships, 8 roles, server-side permissions, organisation isolation, warehouse/branch restriction
- ✅ UI design system (tokens, components, grid, forms), permission-aware navigation, top bar

## Phase 2 – Calendar and fiscal years
- ✅ Shared BS dataset and identical converters (backend/frontend), exhaustive tests
- ✅ Dual date picker, AD/BS/both display modes, date API contract, BS range filters
- ✅ Fiscal years (BS/AD/single periods), activation, overlap protection, period lock/unlock with audit
- ✅ Fiscal-year-aware, concurrency-safe numbering with configurable policies
- ✅ Year-end preview, close, reopen; historical reporting and comparison

## Phase 3 – Master data
- ✅ Customers and suppliers (categories, credit limits, terms, opening balances, restricted bank details)
- ✅ Products and services, categories, brands, units, taxes, price tiers, variants, batch/serial/expiry flags
- ✅ Product CSV/XLSX import with dry run, bulk price updates, barcode lookup
- ✅ Warehouses and storage locations, branches, payment methods, expense categories

## Phase 4 – Inventory
- ✅ Immutable stock ledger, transactional balances, FIFO cost layers, verification
- ✅ Opening stock, adjustments, damage write-offs, reversals
- ✅ Reservations, transfers via goods in transit, stock counts
- ✅ Batch, serial and expiry tracking; negative-stock policy; low-stock alerts
- 🟡 Storage locations are recorded on manual movement lines; stock balances are kept per warehouse, not per bin

## Phase 5 – Sales
- ✅ Orders with approval, credit-limit override, reservation, backorders, cancel/close
- ✅ Deliveries (partial), invoices (from deliveries, policy for invoicing before delivery, direct), PDFs
- ✅ Receipts with multi-invoice allocation, advances, later application, refunds, reversals
- ✅ Customer ledger, statement PDF, aging

## Phase 6 – Purchases
- ✅ Purchase orders with approval; GRNs with accepted/rejected quantities and tracking data
- ✅ Supplier bills (from GRN or direct) with duplicate detection and price variance
- ✅ Payment vouchers (prepared → approved), allocations, advances, supplier refunds, reversals
- ✅ Supplier ledger, statement, aging, purchase documents

## Phase 7 – Returns and accounting
- ✅ Sales returns/credit notes (inspection, restock or damaged), purchase returns/debit notes
- ✅ Chart of accounts, automatic double-entry postings, manual and opening journals, reversals
- ✅ Expenses with approval, cash and bank books, bank reconciliation
- 🟡 Freight and other charges are untaxed; VAT logic is operational, not certified for statutory filing

## Phase 8 – Reporting and audit
- ✅ Dashboard from real data, respecting permissions and the selected fiscal year
- ✅ ~25 reports with fiscal-year/AD/BS filters, explanations, CSV/Excel/PDF export
- ✅ Append-only audit trail with request IDs; per-document timeline and connected documents; attachments

## Phase 9 – Quality and deployment
- ✅ 121 backend tests, 12 frontend tests, strict type-check, production build
- ✅ Docker Compose verified end to end; backup and restore scripts verified by a drill
- ✅ Documentation set (`docs/`), README, frontend conventions
- 🟡 Responsive layouts verified at phone width; the fiscal-year and date-mode selectors are hidden in the mobile
  top bar (date mode remains available under *My account*)
- 🟡 Reference products: only partially accessible (see `reference-review.md`)

## Suggested next steps
1. Electronic billing / IRD integration and certification, if required for the business.
2. Bin-level stock balances and pick lists.
3. Email delivery of invoices and statements; scheduled reports.
4. Multi-currency documents.
