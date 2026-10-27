# Testing

## Commands
```bash
# Backend (needs PostgreSQL – the tests use the real engine, triggers and exclusion constraints)
docker run -d --name erp-dev-db -e POSTGRES_USER=erp -e POSTGRES_PASSWORD=erp -e POSTGRES_DB=erp -p 5433:5432 postgres:16-alpine
cd backend && .venv/bin/python -m pytest -q            # 121 tests, ~1.5 min
.venv/bin/python -m pytest -q tests/test_sales.py -k receipt   # a subset

# Frontend
cd frontend && npm test            # vitest: 12 tests
npm run typecheck && npm run build # strict TypeScript and production bundle
```
`config/settings_test.py` is selected by `pytest.ini`; it uses a fast password hasher, in-memory email and relaxed
auth throttling. Tests that need real commits and concurrency use `@pytest.mark.django_db(transaction=True)`.

## Coverage by requirement
| Area | Tests (file) |
| --- | --- |
| Calendar | known AD↔BS dates, **every day of 1975–2100 BS against nepali-datetime and round-trip**, variable month lengths, invalid BS dates, out-of-range, month boundaries, AD leap day, datetime refusal (no timezone day shift), dual-date serializer input/output, inclusive BS ranges, timezone-aware timestamp bounds, convert endpoint, identical dataset copies, shared fixtures (`test_calendar.py`); frontend: 1,002 backend fixtures, full-range round trip, invalid dates, DatePicker BS/AD entry and validation (`bs.test.ts`, `DatePicker.test.tsx`) |
| Fiscal years | BS/AD/single periods, overlap rejected (service **and** DB exclusion constraint), one active year, previous year stays postable, correct year/period assignment, no-period and draft-year rejection, locked period rejects and leaves no partial data, unlock needs reason + audit + permission, numbering resets per fiscal year, numbering policies (continuous, BS year, branch), number rollback, **80 concurrent numbers from 8 threads all unique**, year-end close (closing journal, retained earnings, carry-forward, locked periods, closed-year rejection, historical P&L), blockers, reopen with reason, permissions, BS input via API (`test_fiscal_years.py`) |
| Inventory | receipt ledger/layer/balance/journal, FIFO across layers, negative stock blocked (nothing written) and allowed policy, reservations and release, transfer via transit with exact layers, duplicate posting, adjustment + reversal, reversal refused after consumption, counts, batch and serial rules, whole units, balances = ledger, **16 concurrent issues of 10 units never oversell** (`test_inventory.py`); transfers and counts through the API (`test_reports.py`) |
| Accounting | balanced posting, unbalanced rejected, **DB trigger rejects tampering with posted lines**, group/inactive accounts, AR requires customer, idempotency, reversal, trial balance, manual journal draft/post/immutability/reverse/permissions, system account protection, opening balances once only, expense approval with server-computed totals, bank reconciliation (`test_accounting.py`) |
| Sales | full order-to-cash (server totals, reservation, partial delivery, COGS at delivery, invoicing delivered qty with order prices, multi-invoice receipt, advance, ledger reconciliation, PDF, timeline), over-allocation/wrong customer, receipt reversal, over-delivery, direct invoice + reversal, return with restock and refund, credit applied to unpaid invoice, credit limit, cancel/reject/edit flow, backorder reservation, invoice-before-delivery policy, document PDFs and copy counter (`test_sales.py`) |
| Purchases | procure-to-pay (approval, partial GRN with rejection, over-receipt, bill from GRN, duplicate supplier invoice, draft → posted vouchers, no double posting, PDFs), price variance and purchase return, direct bill with services and reversal, advance and supplier refund, GRN reversal (`test_purchases.py`) |
| Security | unauthenticated access, login/refresh rotation/replay/logout cookie, foreign-origin refresh, cross-organisation isolation (detail, ledger, update, reports, exports), foreign ids in bodies, role permissions, supplier bank detail masking, warehouse and branch restrictions, closed period via API, client cannot set totals/status/number, posted documents not deletable, audit log read-only, user management, attachment content validation and permission, compact receipt (`test_security.py`) |
| Reports | every report runs with fiscal year, BS range and as-of; revenue vs cash vs profit; date ranges; CSV with AD+BS columns, XLSX and PDF exports; dashboard permissions; stock reports as of a date (`test_reports.py`) |

## End-to-end checks performed during development
* `manage.py seed_demo` posts ~15 months of activity through the real services and fails if stock balances do not
  reconcile; the year-end preview on the result shows a balanced ledger and inventory GL = stock valuation.
* Every route was opened in headless Chrome (Playwright) as the admin user and checked for page errors.
* The Docker Compose stack was built and started, seeded with production settings, exercised through Nginx
  (login, refresh cookie, PDF, report, security headers, request IDs) and put through a backup → change → restore drill.
