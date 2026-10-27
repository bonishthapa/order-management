# Business workflows

## Sales (order to cash)
1. **Sales order** – draft (numbered `SO-…`) → *Submit* → *Approve* (permission `sales.approve`; credit-limit check
   with an audited override) → stock is **reserved** up to what is available; the rest is a backorder.
   Rejected orders can be edited (back to draft). *Cancel* (no deliveries yet) releases reservations;
   *Close* ends a partially delivered order and cancels its backorder. *Reserve available stock* retries
   reservations after goods arrive.
2. **Delivery** – from the order: quantities default to reserved/available; batch and serial numbers for tracked
   items. Posting issues stock (FIFO) and books COGS; over-delivery is impossible.
3. **Invoice** – *Create invoice* bills delivered-but-uninvoiced quantities (or ordered quantities if the
   organisation allows invoicing before delivery). Prices, discounts and taxes come from the order. Posting
   assigns the number and fiscal year and books revenue/VAT/receivable. **Direct invoices** (no order) issue stock
   themselves.
4. **Receipt** – record money (method, deposit account, reference); allocate to one or many invoices (oldest first
   helper) or keep as advance; apply later; refund; reverse (bounced cheque).
5. **Return / credit note** – from a posted invoice; returnable quantities enforced; inspection decides restock or
   damaged; credit applied to the invoice first, any remainder held for the customer or refunded.

Connected navigation: Order → Delivery → Invoice → Receipt → Customer ledger → Journals (each document's
*Activity and documents* tab).

## Purchases (procure to pay)
1. **Purchase order** – draft → submit → approve/reject → cancel or close.
2. **Goods received note** – received, accepted and rejected quantities (with reason), batch/expiry/serials. Only
   posting a GRN (or a direct bill) changes stock. Ordered, received, rejected and billed quantities are tracked
   separately.
3. **Supplier bill** – from received-but-unbilled GRN lines (and unbilled service lines); the supplier's invoice
   number is required and duplicates are detected. Direct bills receive stock themselves.
4. **Payment voucher** – prepared as a draft with requested allocations, then *approved and posted*; supports
   advances, later application, supplier refunds and reversal.
5. **Purchase return / debit note** – from a posted bill; reduces stock at FIFO cost and the payable.

## Inventory
Opening stock, adjustments (+/−) and damage write-offs are manual movements (draft → post → reverse). Transfers go
source → *Goods in transit* → destination (dispatch, then receive). Stock counts snapshot quantities, accept
counted figures and post the difference as an adjustment. All movements carry a number, product, quantity,
warehouse(s), date (AD/BS), reference document, reason, creator and posting time.

## Finance
Expenses: draft → submit → approve (posts) / reject; reverse. Manual and opening-balance journals: draft → post →
reverse. Bank reconciliation: tick cleared book lines up to the statement date; the difference to the statement
balance is stored with the reconciliation.

## Approvals and permissions
| Role | Typical rights |
| --- | --- |
| Company Admin | Everything in the organisation |
| Manager | All operations and approvals; not users, settings, fiscal-year setup/close/reopen |
| Sales Staff | Customers, sales orders, invoices, receipts, returns, sales reports |
| Purchase Staff | Suppliers, products, purchase orders, bills, returns, purchase reports |
| Warehouse Staff | Stock, movements, transfers, counts, deliveries, goods receipts (optionally restricted to warehouses) |
| Accountant | Invoices, bills, receipts, payments, journals, expenses, fiscal periods, all reports, audit |
| Read-only Auditor | View everything incl. reports and audit trail; no changes |
| Super Admin | Platform-level (Django superuser); can enter any organisation |
The full matrix is in Administration → Users and Permissions → Roles, and in `backend/apps/users/roles.py`.
