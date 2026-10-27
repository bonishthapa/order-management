# Database schema

PostgreSQL 16. All business tables carry `organization_id`; documents also `created_by`, `created_at`, `updated_at`.
Money `numeric(18,2)`, quantities `numeric(16,3)`, unit costs/prices `numeric(18,4)`, percentages `numeric(7,4)`.

## Relationships (simplified)
```
Organization ─┬─ Branch ── Warehouse ── StorageLocation
              ├─ Membership ── User           (role, allowed warehouses/branches)
              ├─ FiscalYear ── AccountingPeriod ;  FiscalYearClosing ── JournalEntry (closing / reversal)
              ├─ Account (tree) ── JournalLine ── JournalEntry (period, fiscal_year, source, idempotency_key)
              │                       └─ customer / supplier (party sub-ledger)
              ├─ NumberingPolicy ; DocumentSequence(org, doc_type, scope)
              ├─ TaxRate, UnitOfMeasure, PaymentMethod(→ default Account)
              ├─ Customer(→ category) ; Supplier(→ category)
              ├─ Product(→ category, brand, unit, tax, variant_of) ── PriceTier
              ├─ StockMovement ── StockMovementLine
              │      └─ StockLedgerEntry (immutable) ── CostLayer (FIFO) ; StockBalance(product, warehouse)
              │      Batch, SerialNumber, StockReservation(→ SalesOrderLine)
              ├─ StockTransfer ── lines ;  StockCount ── lines
              ├─ SalesOrder ── SalesOrderLine ── DeliveryLine ── Delivery(→ StockMovement, JournalEntry)
              │        └── SalesInvoice ── SalesInvoiceLine(→ order line) ── SalesReturnLine ── SalesReturn
              ├─ CustomerReceipt ── InvoiceAllocation ──> SalesInvoice   (or SalesReturn credit → invoice)
              ├─ CustomerRefund(→ receipt | credit note)
              ├─ PurchaseOrder ── POLine ── GoodsReceiptLine ── GoodsReceipt(→ StockMovement, JournalEntry)
              │        └── SupplierBill ── BillLine(→ GRN line / PO line) ── PurchaseReturnLine ── PurchaseReturn
              ├─ PaymentVoucher ── BillAllocation ──> SupplierBill   (or PurchaseReturn debit → bill)
              ├─ SupplierRefund ; ExpenseCategory(→ Account) ── Expense(→ JournalEntry)
              ├─ BankReconciliation ── JournalLine.cleared_date
              └─ AuditEvent (append-only) ; Attachment(entity_type, entity_id)
```

## Key constraints
| Table | Constraint |
| --- | --- |
| fiscal year | unique code per org; one `ACTIVE` per org (partial unique); `end > start`; **exclusion constraint** on `(organization =, daterange(start,end,'[]') &&)` (btree_gist) |
| accounting period | unique `(fiscal_year, number)`; `end ≥ start` |
| journal entry | unique number and idempotency key per org; posted ⇒ `total_debit = total_credit`; deferred trigger checks Σ lines balance for posted/reversed entries; trigger blocks changing/deleting posted lines |
| journal line | `debit ≥ 0`, `credit ≥ 0`, exactly one side > 0 |
| document sequence | unique `(organization, doc_type, scope)` |
| documents | unique number per org (where set) |
| sales order line | `qty > 0`, `delivered ≤ qty`, `invoiced ≤ qty` |
| invoice/bill line | `qty > 0`, `returned ≤ qty`; invoice/bill `due ≥ date` |
| GRN line | `received = accepted + rejected`, `billed ≤ accepted` |
| supplier bill | unique `(org, supplier, supplier_invoice_number)` for draft/posted |
| receipts / vouchers | `amount > 0`, `allocated + refunded ≤ amount` |
| allocations | `amount > 0`, exactly one source (money or credit) |
| stock | ledger `quantity ≠ 0`; balance `reserved ≥ 0` and unique `(product, warehouse)`; layers `remaining ≥ 0`; one transit warehouse per org |
| product | unique SKU and barcode per org; services cannot be batch/serial tracked |
| audit event | immutable at ORM level |

Indexes cover organisation + date, organisation + status, party + status, `(account, entry)`, product/warehouse
ledger lookups and reference lookups. The full schema is in the Django migrations (`backend/apps/*/migrations`).
