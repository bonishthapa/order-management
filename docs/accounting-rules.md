# Accounting rules

Operational double-entry bookkeeping with perpetual inventory and FIFO costing. It is **not** a certified
statutory or tax-compliance system: VAT figures follow the configured rates and should be verified against the
applicable Nepali rules (and IRD invoice requirements) before filing.

## Principles
* Every posted journal balances (Σ debit = Σ credit > 0). Enforced by the service, a check constraint and a
  deferred constraint trigger; posted lines cannot be altered or deleted (trigger).
* Receivable and payable lines always name the customer/supplier; party ledgers, statements and aging are
  derived from the general ledger and allocations, never stored separately.
* Each system journal carries an idempotency key (`SI:<id>`, `DN:<id>`, `PV:<id>` …); posting a document twice is
  rejected with `duplicate_posting`.
* Corrections are reversals (mirror journal + `REVERSED` status) or adjustments, never edits or deletions.

## Default chart (created for each organisation)
1100 Cash · 1200 Bank · 1300 Accounts receivable · 1400 Inventory · 1500 VAT receivable · 2100 Accounts payable ·
2150 Goods received not invoiced (GRNI) · 2200 VAT payable · 3100 Owner's capital · 3200 Retained earnings ·
3300 Opening balance equity · 4100 Sales · 4150 Sales returns · 4200 Freight and other charges income ·
5100 COGS · 5200 Purchase price variance · 5300 Inventory adjustments · 5400 Freight inward ·
5500 Purchases – services · 6100–6900 operating expenses. Accounts can be added and renamed; system accounts keep
their type and cannot be deleted.

## When things are recognised
| Event | Recognition |
| --- | --- |
| Sales order created/approved | Nothing in the ledger or stock. Approval only **reserves** stock. |
| Delivery posted | Stock issued at FIFO cost. **Dr COGS / Cr Inventory** |
| Sales invoice posted | Revenue and VAT. **Dr AR (customer) = grand total / Cr Sales (taxable) / Cr VAT payable / Cr Freight & charges income** |
| Direct invoice (no order) with stock items | Invoice journal above **plus** stock issue and **Dr COGS / Cr Inventory** |
| Customer receipt | **Dr Cash/Bank / Cr AR (customer)**; allocations to invoices only match documents |
| Sales return / credit note | **Dr Sales returns (taxable) / Dr VAT payable / Cr AR**; restocked goods **Dr Inventory / Cr COGS** at the original issue cost; damaged goods are not restocked (COGS stays) |
| Customer refund | **Dr AR / Cr Cash/Bank** |
| GRN posted | Accepted quantity into stock at the PO net rate. **Dr Inventory / Cr GRNI** |
| Supplier bill (from GRN) | **Dr GRNI** (GRN value of billed qty) **Dr Purchase price variance** (bill − GRN value) **Dr VAT receivable Dr Freight inward / Cr AP (supplier)** |
| Direct bill with stock items | Stock received at the bill net rate, **Dr Inventory** instead of GRNI |
| Non-stock / service lines | **Dr Purchases – services** |
| Payment voucher | **Dr AP / Cr Cash/Bank** |
| Purchase return / debit note | **Dr AP / Cr Inventory (FIFO cost removed) / Cr VAT receivable / ± Purchase price variance** |
| Supplier refund | **Dr Cash/Bank / Cr AP** |
| Expense approved | **Dr Expense account / Dr VAT receivable / Cr Cash/Bank** |
| Opening stock | **Dr Inventory / Cr Opening balance equity** |
| Stock adjustment, write-off, count difference | **Dr/Cr Inventory ↔ Inventory adjustments** |
| Stock transfer | No journal; cost layers move with the goods through the *Goods in transit* warehouse |
| Year-end close | Income and expense balances → Retained earnings |

Freight and other charges on invoices/bills are not taxed in this version.

## Pricing and rounding
Per line, each step rounded half-up to 2 decimals: gross = qty × rate; discount = gross × % ; taxable = gross −
discount; tax = taxable × rate %; total = taxable + tax. Document totals are sums of rounded line values plus
freight and other charges. Quantities have 3 decimals, unit costs 4, money 2.

## FIFO costing
* Inbound stock creates a cost layer (GRN: PO net rate; direct bill: bill net rate; opening/adjustment: entered or
  last cost; sales return: original issue cost; transfer: the exact layers that left the source).
* Outbound stock consumes the oldest layers (restricted to a batch when one is chosen). When stock reaches zero
  the remaining value is cleared exactly, so no rounding residue accumulates.
* Reversals restore or remove the exact layers/values of the original movement; reversing a receipt whose stock
  has already been used is refused (post a return or adjustment instead).
* Negative stock is blocked by default. If an organisation allows it, uncovered quantity is costed at the last
  known unit cost and the difference surfaces at the next stock count.
* The stock ledger is the source of truth; `StockBalance` is maintained in the same transaction and can be verified
  (`inventory.services.verify_balances`) – the year-end preview also checks inventory GL = stock valuation.

## Allocations, advances and status
Invoice/bill `amount_paid`, `amount_credited`, `balance_due` and payment status are recomputed from active
allocations inside the posting transaction; clients cannot set them. Unallocated money stays on the party's ledger
as an advance and can be applied later or refunded.
