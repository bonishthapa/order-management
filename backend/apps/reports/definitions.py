from collections import OrderedDict
from dataclasses import dataclass
from decimal import Decimal

from django.db.models import Count, F, Q, Sum

from apps.accounting.models import Account, AccountType, JournalSource, SystemAccount
from apps.accounting.services import posted_lines
from apps.calendar_utils.bs import ad_to_bs, month_names
from apps.calendar_utils.fields import bs_or_none
from apps.calendar_utils.ranges import DateRange
from apps.core.money import ZERO

from .registry import col, report

GROUP_PARAM = {"name": "group", "label": "Group by", "options": [["bs_month", "BS month"], ["ad_month", "AD month"], ["day", "Day"]]}


@dataclass
class Ctx:
    organization: object
    range: DateRange
    params: dict
    as_of: object = None
    user: object = None


def _bucket(date, group):
    if group == "day":
        return date.isoformat(), f"{date.isoformat()} ({bs_or_none(date)} BS)"
    if group == "ad_month":
        return date.strftime("%Y-%m"), date.strftime("%b %Y")
    bs = ad_to_bs(date)
    return f"{bs.year:04d}-{bs.month:02d}", f"{month_names()[bs.month - 1]} {bs.year}"


def _sum(qs, field):
    return qs.aggregate(s=Sum(field))["s"] or ZERO


def _totals(rows, keys):
    return {k: sum((r.get(k) or ZERO for r in rows), ZERO) for k in keys}


# --- Sales ------------------------------------------------------------------------------------


def _posted_invoices(ctx):
    from apps.sales.models import SalesInvoice

    return SalesInvoice.objects.filter(organization=ctx.organization, status="POSTED", **ctx.range.filter_kwargs("invoice_date"))


def _posted_sales_returns(ctx):
    from apps.sales.models import SalesReturn

    return SalesReturn.objects.filter(organization=ctx.organization, status="POSTED", **ctx.range.filter_kwargs("date"))


@report("sales-by-date", "Sales by period", "Sales", "reports.sales",
        "Posted invoices by invoice date (reversed invoices excluded). Net sales = invoiced amount before tax − sales "
        "returns before tax. Freight/charges and VAT are shown separately. This is revenue, not cash received.",
        params=[GROUP_PARAM])
def sales_by_date(ctx):
    group = ctx.params.get("group", "bs_month")
    buckets = OrderedDict()

    def bucket(date):
        key, label = _bucket(date, group)
        return buckets.setdefault(key, {"period": label, "invoices": 0, "gross_sales": ZERO, "returns": ZERO,
                                        "net_sales": ZERO, "charges": ZERO, "tax": ZERO, "total": ZERO})

    for inv in _posted_invoices(ctx).order_by("invoice_date"):
        b = bucket(inv.invoice_date)
        b["invoices"] += 1
        b["gross_sales"] += inv.taxable_total
        b["charges"] += inv.freight + inv.other_charges
        b["tax"] += inv.tax_total
        b["total"] += inv.grand_total
    for ret in _posted_sales_returns(ctx).order_by("date"):
        b = bucket(ret.date)
        b["returns"] += ret.taxable_total
        b["tax"] -= ret.tax_total
        b["total"] -= ret.grand_total
    rows = [buckets[k] for k in sorted(buckets)]
    for r in rows:
        r["net_sales"] = r["gross_sales"] - r["returns"]
    return {
        "columns": [col("period", "Period"), col("invoices", "Invoices", "number"), col("gross_sales", "Gross sales", "money"),
                    col("returns", "Returns", "money"), col("net_sales", "Net sales", "money"), col("charges", "Freight & charges", "money"),
                    col("tax", "VAT", "money"), col("total", "Total incl. VAT", "money")],
        "rows": rows,
        "totals": _totals(rows, ["invoices", "gross_sales", "returns", "net_sales", "charges", "tax", "total"]),
        "chart": {"type": "bar", "x": "period", "series": ["net_sales"]},
    }


@report("sales-by-customer", "Sales by customer", "Sales", "reports.sales",
        "Net sales (before VAT) per customer from posted invoices less posted returns in the period. "
        "Receipts are cash collected in the same period; balance is the receivable at the end date.")
def sales_by_customer(ctx):
    from apps.accounting.services import party_balance
    from apps.customers.models import Customer
    from apps.payments.models import CustomerReceipt

    rows = {}
    for row in _posted_invoices(ctx).values("customer").annotate(n=Count("id"), net=Sum("taxable_total"), tax=Sum("tax_total"),
                                                                 total=Sum("grand_total")):
        rows[row["customer"]] = {"invoices": row["n"], "net_sales": row["net"], "tax": row["tax"], "total": row["total"],
                                 "returns": ZERO, "receipts": ZERO}
    for row in _posted_sales_returns(ctx).values("customer").annotate(net=Sum("taxable_total"), total=Sum("grand_total")):
        r = rows.setdefault(row["customer"], {"invoices": 0, "net_sales": ZERO, "tax": ZERO, "total": ZERO, "returns": ZERO, "receipts": ZERO})
        r["returns"] = row["net"]
    receipts = CustomerReceipt.objects.filter(organization=ctx.organization, status="POSTED", **ctx.range.filter_kwargs("date"))
    for row in receipts.values("customer").annotate(s=Sum("amount")):
        r = rows.setdefault(row["customer"], {"invoices": 0, "net_sales": ZERO, "tax": ZERO, "total": ZERO, "returns": ZERO, "receipts": ZERO})
        r["receipts"] = row["s"]
    customers = {c.pk: c for c in Customer.objects.filter(pk__in=rows.keys())}
    result = []
    for pk, r in rows.items():
        c = customers[pk]
        result.append({"customer_id": pk, "code": c.code, "customer": c.name, **r, "net_after_returns": r["net_sales"] - r["returns"],
                       "balance": party_balance(ctx.organization, customer=c, end=ctx.range.end)})
    result.sort(key=lambda r: -r["net_after_returns"])
    return {
        "columns": [col("code", "Code"), col("customer", "Customer"), col("invoices", "Invoices", "number"),
                    col("net_sales", "Sales", "money"), col("returns", "Returns", "money"),
                    col("net_after_returns", "Net sales", "money"), col("receipts", "Receipts", "money"),
                    col("balance", "Balance", "money")],
        "rows": result,
        "totals": _totals(result, ["invoices", "net_sales", "returns", "net_after_returns", "receipts", "balance"]),
        "links": {"customer": "customers"},
    }


def _product_costs(ctx):
    """Net cost of goods sold per product in the period from the stock ledger (issues − restocked returns)."""
    from apps.inventory.models import StockLedgerEntry

    qs = StockLedgerEntry.objects.filter(organization=ctx.organization, movement_type__in=["ISSUE", "SALES_RETURN"],
                                         **ctx.range.filter_kwargs("date"))
    # Reversals of deliveries/direct invoices restore stock with movement type REVERSAL and reference the sale.
    rev = StockLedgerEntry.objects.filter(organization=ctx.organization, movement_type="REVERSAL",
                                          reference_type__in=["delivery", "sales_invoice"], **ctx.range.filter_kwargs("date"))
    costs = {}
    for row in qs.values("product").annotate(v=Sum("value")):
        costs[row["product"]] = -row["v"]
    for row in rev.values("product").annotate(v=Sum("value")):
        costs[row["product"]] = costs.get(row["product"], ZERO) - row["v"]
    return costs


@report("sales-by-product", "Sales and gross profit by product", "Sales", "reports.sales",
        "Quantity and net revenue (before VAT) from posted invoice lines less return lines. Cost is the FIFO cost of "
        "stock issued to customers in the period (deliveries and direct invoices) less returned stock, matching the COGS "
        "account. Gross profit = net revenue − cost.")
def sales_by_product(ctx):
    from apps.products.models import Product
    from apps.sales.models import SalesInvoiceLine, SalesReturnLine

    rows = {}
    for row in SalesInvoiceLine.objects.filter(invoice__organization=ctx.organization, invoice__status="POSTED",
                                               **ctx.range.filter_kwargs("invoice__invoice_date")) \
            .values("product").annotate(q=Sum("quantity"), v=Sum("taxable_amount")):
        rows[row["product"]] = {"quantity": row["q"], "revenue": row["v"]}
    for row in SalesReturnLine.objects.filter(sales_return__organization=ctx.organization, sales_return__status="POSTED",
                                              **ctx.range.filter_kwargs("sales_return__date")) \
            .values("product").annotate(q=Sum("quantity"), v=Sum("taxable_amount")):
        r = rows.setdefault(row["product"], {"quantity": ZERO, "revenue": ZERO})
        r["quantity"] -= row["q"]
        r["revenue"] -= row["v"]
    costs = _product_costs(ctx)
    for pid in costs:
        rows.setdefault(pid, {"quantity": ZERO, "revenue": ZERO})
    products = {p.pk: p for p in Product.objects.filter(pk__in=rows.keys()).select_related("unit", "category")}
    result = []
    for pid, r in rows.items():
        p = products[pid]
        cost = costs.get(pid, ZERO)
        profit = r["revenue"] - cost
        result.append({"product_id": pid, "sku": p.sku, "product": p.name, "category": p.category.name if p.category else "",
                       "unit": p.unit.code, "quantity": r["quantity"], "revenue": r["revenue"], "cost": cost,
                       "gross_profit": profit, "margin": (profit / r["revenue"] * 100).quantize(Decimal("0.1")) if r["revenue"] else None})
    result.sort(key=lambda r: -r["revenue"])
    return {
        "columns": [col("sku", "SKU"), col("product", "Product"), col("category", "Category"), col("quantity", "Qty", "qty"),
                    col("unit", "Unit"), col("revenue", "Net revenue", "money"), col("cost", "Cost (FIFO)", "money"),
                    col("gross_profit", "Gross profit", "money"), col("margin", "Margin %", "percent")],
        "rows": result,
        "totals": _totals(result, ["revenue", "cost", "gross_profit"]),
        "links": {"product": "products"},
    }


@report("sales-returns", "Sales returns and credit notes", "Sales", "reports.sales",
        "Posted sales returns in the period. Credit applied reduces invoices; unapplied credit is held for the customer "
        "or refunded.")
def sales_returns(ctx):
    rows = [{"id": r.pk, "number": r.number, "date": r.date, "customer": r.customer.name, "invoice": r.invoice.number,
             "reason": r.reason, "net": r.taxable_total, "tax": r.tax_total, "total": r.grand_total,
             "applied": r.credit_applied, "refunded": r.refunded_amount, "unapplied": r.unapplied_credit}
            for r in _posted_sales_returns(ctx).select_related("customer", "invoice").order_by("date", "id")]
    return {
        "columns": [col("date", "Date", "date"), col("number", "Credit note"), col("customer", "Customer"),
                    col("invoice", "Invoice"), col("reason", "Reason"), col("net", "Net", "money"), col("tax", "VAT", "money"),
                    col("total", "Total", "money"), col("applied", "Applied", "money"), col("refunded", "Refunded", "money"),
                    col("unapplied", "Unapplied", "money")],
        "rows": rows, "totals": _totals(rows, ["net", "tax", "total", "applied", "refunded", "unapplied"]),
        "links": {"number": "sales-returns"},
    }


@report("payment-collection", "Payment collection", "Sales", "reports.sales",
        "Cash actually received from customers (posted receipts, reversed receipts excluded) by payment method and "
        "account. This is cash, not revenue.", params=[{"name": "detail", "label": "Show receipts", "type": "boolean"}])
def payment_collection(ctx):
    from apps.payments.models import CustomerReceipt

    qs = CustomerReceipt.objects.filter(organization=ctx.organization, status="POSTED", **ctx.range.filter_kwargs("date"))
    if ctx.params.get("detail") == "true":
        rows = [{"id": r.pk, "number": r.number, "date": r.date, "customer": r.customer.name, "method": r.payment_method.name,
                 "account": str(r.deposit_account), "reference": r.reference, "amount": r.amount, "allocated": r.allocated_amount,
                 "unapplied": r.unapplied_amount}
                for r in qs.select_related("customer", "payment_method", "deposit_account").order_by("date", "id")]
        return {"columns": [col("date", "Date", "date"), col("number", "Receipt"), col("customer", "Customer"),
                            col("method", "Method"), col("account", "Account"), col("reference", "Reference"),
                            col("amount", "Amount", "money"), col("allocated", "Allocated", "money"),
                            col("unapplied", "Unapplied", "money")],
                "rows": rows, "totals": _totals(rows, ["amount", "allocated", "unapplied"]), "links": {"number": "sales-receipts"}}
    rows = [{"method": r["payment_method__name"], "account": f'{r["deposit_account__code"]} {r["deposit_account__name"]}',
             "count": r["n"], "amount": r["s"]}
            for r in qs.values("payment_method__name", "deposit_account__code", "deposit_account__name")
            .annotate(n=Count("id"), s=Sum("amount")).order_by("payment_method__name")]
    return {"columns": [col("method", "Payment method"), col("account", "Deposited to"), col("count", "Receipts", "number"),
                        col("amount", "Amount", "money")],
            "rows": rows, "totals": _totals(rows, ["count", "amount"])}


# --- Receivables / payables -------------------------------------------------------------------


def _party_balances(ctx, kind):
    from apps.customers.models import Customer
    from apps.suppliers.models import Supplier

    end = ctx.as_of
    key = SystemAccount.RECEIVABLE if kind == "customer" else SystemAccount.PAYABLE
    qs = posted_lines(ctx.organization).filter(account__system_key=key, entry__date__lte=end)
    rows = []
    agg = qs.values(kind).annotate(d=Sum("debit"), c=Sum("credit"))
    model = Customer if kind == "customer" else Supplier
    parties = {p.pk: p for p in model.objects.filter(organization=ctx.organization)}
    for row in agg:
        net = (row["d"] or ZERO) - (row["c"] or ZERO)
        balance = net if kind == "customer" else -net
        if balance == 0:
            continue
        p = parties[row[kind]]
        rows.append({"party_id": p.pk, "code": p.code, "name": p.name, "phone": p.phone, "debit": row["d"], "credit": row["c"],
                     "balance": balance})
    rows.sort(key=lambda r: -r["balance"])
    return rows


@report("customer-receivables", "Customer balances", "Receivables & payables", "reports.financial",
        "Accounts-receivable balance per customer as of the date, from the general ledger (invoices − receipts − credit "
        "notes + refunds + opening balances). Negative balances are customer advances.", period="as_of")
def customer_receivables(ctx):
    rows = _party_balances(ctx, "customer")
    return {"columns": [col("code", "Code"), col("name", "Customer"), col("phone", "Phone"), col("debit", "Total debits", "money"),
                        col("credit", "Total credits", "money"), col("balance", "Balance", "money")],
            "rows": rows, "totals": _totals(rows, ["debit", "credit", "balance"]), "links": {"name": "customers"}}


@report("supplier-payables", "Supplier balances", "Receivables & payables", "reports.financial",
        "Accounts-payable balance per supplier as of the date from the general ledger (bills − payments − debit notes "
        "+ refunds + opening balances). Negative balances are advances paid.", period="as_of")
def supplier_payables(ctx):
    rows = _party_balances(ctx, "supplier")
    return {"columns": [col("code", "Code"), col("name", "Supplier"), col("phone", "Phone"), col("debit", "Total debits", "money"),
                        col("credit", "Total credits", "money"), col("balance", "Balance", "money")],
            "rows": rows, "totals": _totals(rows, ["debit", "credit", "balance"]), "links": {"name": "suppliers"}}


def _aging_report(data, party_label, link):
    rows = [{"party_id": p["party_id"], "code": p["party_code"], "name": p["party_name"],
             **{b["key"]: p[b["key"]] for b in data["buckets"]}, "total": p["total"]} for p in data["parties"]]
    return {"columns": [col("code", "Code"), col("name", party_label)] + [col(b["key"], b["label"], "money") for b in data["buckets"]]
            + [col("total", "Total", "money")],
            "rows": rows, "totals": {k: v for k, v in data["totals"].items()}, "links": {"name": link},
            "details": data["documents"]}


@report("receivable-aging", "Receivable aging", "Receivables & payables", "reports.financial",
        "Open invoice amounts as of the date, by days past the due date. Allocations (receipts and credit notes) dated "
        "after the as-of date are ignored. Unapplied advances are not deducted here; see Customer balances.", period="as_of")
def receivable_aging_report(ctx):
    from apps.accounting.ledgers import receivable_aging

    return _aging_report(receivable_aging(ctx.organization, ctx.as_of), "Customer", "customers")


@report("payable-aging", "Payable aging", "Receivables & payables", "reports.financial",
        "Open supplier bill amounts as of the date by days past due. Payments and debit notes dated after the as-of date "
        "are ignored.", period="as_of")
def payable_aging_report(ctx):
    from apps.accounting.ledgers import payable_aging

    return _aging_report(payable_aging(ctx.organization, ctx.as_of), "Supplier", "suppliers")


# --- Purchases --------------------------------------------------------------------------------


def _posted_bills(ctx):
    from apps.purchases.models import SupplierBill

    return SupplierBill.objects.filter(organization=ctx.organization, status="POSTED", **ctx.range.filter_kwargs("bill_date"))


def _posted_purchase_returns(ctx):
    from apps.purchases.models import PurchaseReturn

    return PurchaseReturn.objects.filter(organization=ctx.organization, status="POSTED", **ctx.range.filter_kwargs("date"))


@report("purchases-by-date", "Purchases by period", "Purchases", "reports.purchases",
        "Posted supplier bills by bill date less posted purchase returns, before VAT. Goods received but not yet billed "
        "are not included (see Goods received not invoiced in the trial balance).", params=[GROUP_PARAM])
def purchases_by_date(ctx):
    group = ctx.params.get("group", "bs_month")
    buckets = OrderedDict()

    def bucket(date):
        key, label = _bucket(date, group)
        return buckets.setdefault(key, {"period": label, "bills": 0, "purchases": ZERO, "returns": ZERO, "net": ZERO,
                                        "charges": ZERO, "tax": ZERO, "total": ZERO})

    for bill in _posted_bills(ctx).order_by("bill_date"):
        b = bucket(bill.bill_date)
        b["bills"] += 1
        b["purchases"] += bill.taxable_total
        b["charges"] += bill.freight + bill.other_charges
        b["tax"] += bill.tax_total
        b["total"] += bill.grand_total
    for ret in _posted_purchase_returns(ctx).order_by("date"):
        b = bucket(ret.date)
        b["returns"] += ret.taxable_total
        b["tax"] -= ret.tax_total
        b["total"] -= ret.grand_total
    rows = [buckets[k] for k in sorted(buckets)]
    for r in rows:
        r["net"] = r["purchases"] - r["returns"]
    return {"columns": [col("period", "Period"), col("bills", "Bills", "number"), col("purchases", "Purchases", "money"),
                        col("returns", "Returns", "money"), col("net", "Net purchases", "money"),
                        col("charges", "Freight & charges", "money"), col("tax", "VAT", "money"), col("total", "Total incl. VAT", "money")],
            "rows": rows, "totals": _totals(rows, ["bills", "purchases", "returns", "net", "charges", "tax", "total"]),
            "chart": {"type": "bar", "x": "period", "series": ["net"]}}


@report("purchases-by-supplier", "Purchases by supplier", "Purchases", "reports.purchases",
        "Net purchases (before VAT) per supplier from posted bills less returns; payments are vouchers posted in the "
        "period; balance is the payable at the end date.")
def purchases_by_supplier(ctx):
    from apps.accounting.services import party_balance
    from apps.payments.models import PaymentVoucher
    from apps.suppliers.models import Supplier

    rows = {}
    blank = lambda: {"bills": 0, "purchases": ZERO, "returns": ZERO, "payments": ZERO}  # noqa: E731
    for row in _posted_bills(ctx).values("supplier").annotate(n=Count("id"), net=Sum("taxable_total")):
        r = rows.setdefault(row["supplier"], blank())
        r["bills"], r["purchases"] = row["n"], row["net"]
    for row in _posted_purchase_returns(ctx).values("supplier").annotate(net=Sum("taxable_total")):
        rows.setdefault(row["supplier"], blank())["returns"] = row["net"]
    for row in PaymentVoucher.objects.filter(organization=ctx.organization, status="POSTED", **ctx.range.filter_kwargs("date")) \
            .values("supplier").annotate(s=Sum("amount")):
        rows.setdefault(row["supplier"], blank())["payments"] = row["s"]
    suppliers = {s.pk: s for s in Supplier.objects.filter(pk__in=rows.keys())}
    result = []
    for pk, r in rows.items():
        s = suppliers[pk]
        result.append({"supplier_id": pk, "code": s.code, "supplier": s.name, **r, "net": r["purchases"] - r["returns"],
                       "balance": party_balance(ctx.organization, supplier=s, end=ctx.range.end)})
    result.sort(key=lambda r: -r["net"])
    return {"columns": [col("code", "Code"), col("supplier", "Supplier"), col("bills", "Bills", "number"),
                        col("purchases", "Purchases", "money"), col("returns", "Returns", "money"), col("net", "Net", "money"),
                        col("payments", "Payments", "money"), col("balance", "Balance", "money")],
            "rows": result, "totals": _totals(result, ["bills", "purchases", "returns", "net", "payments", "balance"]),
            "links": {"supplier": "suppliers"}}


@report("purchases-by-product", "Purchases by product", "Purchases", "reports.purchases",
        "Quantity and net amount (before VAT) per product from posted bill lines less purchase-return lines.")
def purchases_by_product(ctx):
    from apps.products.models import Product
    from apps.purchases.models import PurchaseReturnLine, SupplierBillLine

    rows = {}
    for row in SupplierBillLine.objects.filter(bill__organization=ctx.organization, bill__status="POSTED",
                                               **ctx.range.filter_kwargs("bill__bill_date")) \
            .values("product").annotate(q=Sum("quantity"), v=Sum("taxable_amount")):
        rows[row["product"]] = {"quantity": row["q"], "amount": row["v"]}
    for row in PurchaseReturnLine.objects.filter(purchase_return__organization=ctx.organization, purchase_return__status="POSTED",
                                                 **ctx.range.filter_kwargs("purchase_return__date")) \
            .values("product").annotate(q=Sum("quantity"), v=Sum("taxable_amount")):
        r = rows.setdefault(row["product"], {"quantity": ZERO, "amount": ZERO})
        r["quantity"] -= row["q"]
        r["amount"] -= row["v"]
    products = {p.pk: p for p in Product.objects.filter(pk__in=rows.keys()).select_related("unit")}
    result = [{"product_id": pid, "sku": products[pid].sku, "product": products[pid].name, "unit": products[pid].unit.code,
               "quantity": r["quantity"], "amount": r["amount"],
               "average_rate": (r["amount"] / r["quantity"]).quantize(Decimal("0.01")) if r["quantity"] else None}
              for pid, r in rows.items()]
    result.sort(key=lambda r: -r["amount"])
    return {"columns": [col("sku", "SKU"), col("product", "Product"), col("quantity", "Qty", "qty"), col("unit", "Unit"),
                        col("amount", "Net amount", "money"), col("average_rate", "Avg. rate", "money")],
            "rows": result, "totals": _totals(result, ["amount"]), "links": {"product": "products"}}


@report("purchase-returns", "Purchase returns and debit notes", "Purchases", "reports.purchases",
        "Posted purchase returns in the period with how much of each debit note has been applied or refunded.")
def purchase_returns(ctx):
    rows = [{"id": r.pk, "number": r.number, "date": r.date, "supplier": r.supplier.name, "bill": r.bill.number,
             "reason": r.reason, "net": r.taxable_total, "tax": r.tax_total, "total": r.grand_total,
             "applied": r.credit_applied, "refunded": r.refunded_amount, "unapplied": r.unapplied_credit}
            for r in _posted_purchase_returns(ctx).select_related("supplier", "bill").order_by("date", "id")]
    return {"columns": [col("date", "Date", "date"), col("number", "Debit note"), col("supplier", "Supplier"),
                        col("bill", "Bill"), col("reason", "Reason"), col("net", "Net", "money"), col("tax", "VAT", "money"),
                        col("total", "Total", "money"), col("applied", "Applied", "money"), col("refunded", "Refunded", "money"),
                        col("unapplied", "Unapplied", "money")],
            "rows": rows, "totals": _totals(rows, ["net", "tax", "total", "applied", "refunded", "unapplied"]),
            "links": {"number": "purchase-returns"}}


@report("supplier-payments", "Supplier payments", "Purchases", "reports.purchases",
        "Posted payment vouchers in the period (cash paid to suppliers).")
def supplier_payments(ctx):
    from apps.payments.models import PaymentVoucher

    rows = [{"id": v.pk, "number": v.number, "date": v.date, "supplier": v.supplier.name, "method": v.payment_method.name,
             "account": str(v.paid_from_account), "reference": v.reference, "amount": v.amount, "allocated": v.allocated_amount,
             "unapplied": v.unapplied_amount}
            for v in PaymentVoucher.objects.filter(organization=ctx.organization, status="POSTED", **ctx.range.filter_kwargs("date"))
            .select_related("supplier", "payment_method", "paid_from_account").order_by("date", "id")]
    return {"columns": [col("date", "Date", "date"), col("number", "Voucher"), col("supplier", "Supplier"), col("method", "Method"),
                        col("account", "Paid from"), col("reference", "Reference"), col("amount", "Amount", "money"),
                        col("allocated", "Allocated", "money"), col("unapplied", "Unapplied", "money")],
            "rows": rows, "totals": _totals(rows, ["amount", "allocated", "unapplied"]), "links": {"number": "payment-vouchers"}}


# --- Inventory --------------------------------------------------------------------------------

WAREHOUSE_PARAM = {"name": "warehouse", "label": "Warehouse", "type": "warehouse"}


@report("inventory-valuation", "Inventory valuation", "Inventory", "reports.inventory",
        "Quantity and FIFO value on hand as of the date, summed from the posted stock ledger (every receipt, issue, "
        "transfer, adjustment and reversal up to and including the date). Goods in transit are listed separately.",
        params=[WAREHOUSE_PARAM], period="as_of")
def inventory_valuation(ctx):
    from apps.inventory.models import StockLedgerEntry

    qs = StockLedgerEntry.objects.filter(organization=ctx.organization, date__lte=ctx.as_of)
    if ctx.params.get("warehouse"):
        qs = qs.filter(warehouse_id=ctx.params["warehouse"])
    rows = []
    for r in qs.values("product", "product__sku", "product__name", "product__unit__code", "product__category__name",
                       "warehouse__code", "warehouse__is_transit").annotate(q=Sum("quantity"), v=Sum("value")) \
            .order_by("product__name", "warehouse__code"):
        if r["q"] == 0 and r["v"] == 0:
            continue
        rows.append({"product_id": r["product"], "sku": r["product__sku"], "product": r["product__name"],
                     "category": r["product__category__name"] or "", "warehouse": r["warehouse__code"] + (" (in transit)" if r["warehouse__is_transit"] else ""),
                     "unit": r["product__unit__code"], "quantity": r["q"], "value": r["v"],
                     "unit_cost": (r["v"] / r["q"]).quantize(Decimal("0.0001")) if r["q"] else None})
    return {"columns": [col("sku", "SKU"), col("product", "Product"), col("category", "Category"), col("warehouse", "Warehouse"),
                        col("quantity", "Qty", "qty"), col("unit", "Unit"), col("unit_cost", "Avg. cost", "money"),
                        col("value", "Value", "money")],
            "rows": rows, "totals": _totals(rows, ["value"]), "links": {"product": "products"}}


@report("stock-movement", "Stock movement summary", "Inventory", "reports.inventory",
        "Per product: opening quantity before the start date, quantities in and out during the period, and closing "
        "quantity, from the posted stock ledger. Transfers count as in/out of each warehouse.", params=[WAREHOUSE_PARAM])
def stock_movement(ctx):
    from apps.inventory.models import StockLedgerEntry

    base = StockLedgerEntry.objects.filter(organization=ctx.organization, warehouse__is_transit=False)
    if ctx.params.get("warehouse"):
        base = base.filter(warehouse_id=ctx.params["warehouse"])
    opening = {}
    if ctx.range.start:
        for r in base.filter(date__lt=ctx.range.start).values("product").annotate(q=Sum("quantity"), v=Sum("value")):
            opening[r["product"]] = (r["q"], r["v"])
    period = base.filter(**ctx.range.filter_kwargs("date"))
    movement = {r["product"]: r for r in period.values("product").annotate(
        qin=Sum("quantity", filter=Q(quantity__gt=0)), qout=Sum("quantity", filter=Q(quantity__lt=0)),
        vin=Sum("value", filter=Q(value__gt=0)), vout=Sum("value", filter=Q(value__lt=0)))}
    from apps.products.models import Product

    ids = set(opening) | set(movement)
    products = {p.pk: p for p in Product.objects.filter(pk__in=ids).select_related("unit")}
    rows = []
    for pid in ids:
        p = products[pid]
        oq, ov = opening.get(pid, (ZERO, ZERO))
        m = movement.get(pid, {})
        qin, qout = m.get("qin") or ZERO, -(m.get("qout") or ZERO)
        vin, vout = m.get("vin") or ZERO, -(m.get("vout") or ZERO)
        rows.append({"product_id": pid, "sku": p.sku, "product": p.name, "unit": p.unit.code, "opening_qty": oq,
                     "in_qty": qin, "out_qty": qout, "closing_qty": oq + qin - qout, "opening_value": ov, "in_value": vin,
                     "out_value": vout, "closing_value": ov + vin - vout})
    rows.sort(key=lambda r: r["product"])
    return {"columns": [col("sku", "SKU"), col("product", "Product"), col("unit", "Unit"), col("opening_qty", "Opening", "qty"),
                        col("in_qty", "In", "qty"), col("out_qty", "Out", "qty"), col("closing_qty", "Closing", "qty"),
                        col("opening_value", "Opening value", "money"), col("in_value", "In value", "money"),
                        col("out_value", "Out value", "money"), col("closing_value", "Closing value", "money")],
            "rows": rows, "totals": _totals(rows, ["opening_value", "in_value", "out_value", "closing_value"]),
            "links": {"product": "products"}}


@report("low-stock", "Low-stock products", "Inventory", "reports.inventory",
        "Active stock items whose current on-hand quantity across selling warehouses is at or below the reorder level.",
        period="none")
def low_stock(ctx):
    from apps.inventory.models import StockBalance
    from apps.products.models import Product

    totals = {r["product"]: r for r in StockBalance.objects.filter(organization=ctx.organization, warehouse__is_transit=False)
              .values("product").annotate(on_hand=Sum("on_hand"), reserved=Sum("reserved"))}
    rows = []
    for p in Product.objects.filter(organization=ctx.organization, is_active=True, product_type="STOCK", reorder_level__gt=0) \
            .select_related("unit"):
        t = totals.get(p.pk, {"on_hand": ZERO, "reserved": ZERO})
        if t["on_hand"] <= p.reorder_level:
            rows.append({"product_id": p.pk, "sku": p.sku, "product": p.name, "unit": p.unit.code, "on_hand": t["on_hand"],
                         "reserved": t["reserved"], "available": t["on_hand"] - t["reserved"], "reorder_level": p.reorder_level,
                         "suggested_order": max(p.reorder_quantity or (p.reorder_level * 2 - t["on_hand"]), ZERO)})
    rows.sort(key=lambda r: r["on_hand"] - r["reorder_level"])
    return {"columns": [col("sku", "SKU"), col("product", "Product"), col("unit", "Unit"), col("on_hand", "On hand", "qty"),
                        col("reserved", "Reserved", "qty"), col("available", "Available", "qty"),
                        col("reorder_level", "Reorder level", "qty"), col("suggested_order", "Suggested order", "qty")],
            "rows": rows, "totals": {}, "links": {"product": "products"}}


@report("stock-count-variance", "Stock count variances", "Inventory", "reports.inventory",
        "Posted stock counts in the period: system snapshot, counted quantity and difference per line. The posted "
        "adjustment is valued at FIFO cost.")
def stock_count_variance(ctx):
    from apps.inventory.models import StockCountLine

    rows = []
    for line in StockCountLine.objects.filter(count__organization=ctx.organization, count__status="POSTED",
                                              **ctx.range.filter_kwargs("count__date")).select_related("count", "count__warehouse", "product"):
        rows.append({"count_id": line.count_id, "number": line.count.number, "date": line.count.date,
                     "warehouse": line.count.warehouse.code, "sku": line.product.sku, "product": line.product.name,
                     "system": line.system_quantity, "counted": line.counted_quantity, "difference": line.difference})
    return {"columns": [col("date", "Date", "date"), col("number", "Count"), col("warehouse", "Warehouse"), col("sku", "SKU"),
                        col("product", "Product"), col("system", "System qty", "qty"), col("counted", "Counted", "qty"),
                        col("difference", "Difference", "qty")],
            "rows": rows, "totals": {}, "links": {"number": "stock-counts"}}


# --- Financial --------------------------------------------------------------------------------


@report("trial-balance", "Trial balance", "Financial", "reports.financial",
        "Opening balance before the start date, debits and credits in the period, and closing balance for every account "
        "with activity, from posted journals. Debit balances are positive. Totals of debits and credits must agree.")
def trial_balance_report(ctx):
    from apps.accounting.services import trial_balance

    rows = trial_balance(ctx.organization, start=ctx.range.start, end=ctx.range.end)
    for r in rows:
        r["closing_debit"] = r["closing"] if r["closing"] > 0 else ZERO
        r["closing_credit"] = -r["closing"] if r["closing"] < 0 else ZERO
    return {"columns": [col("code", "Code"), col("name", "Account"), col("type", "Type"), col("opening", "Opening", "money"),
                        col("debit", "Debit", "money"), col("credit", "Credit", "money"),
                        col("closing_debit", "Closing Dr", "money"), col("closing_credit", "Closing Cr", "money")],
            "rows": rows, "totals": _totals(rows, ["debit", "credit", "closing_debit", "closing_credit"]),
            "links": {"name": "accounts"}}


def _pl_rows(organization, start, end):
    qs = posted_lines(organization).filter(account__account_type__in=[AccountType.INCOME, AccountType.EXPENSE]) \
        .exclude(entry__source=JournalSource.YEAR_END)
    if start:
        qs = qs.filter(entry__date__gte=start)
    if end:
        qs = qs.filter(entry__date__lte=end)
    data = {}
    for r in qs.values("account").annotate(d=Sum("debit"), c=Sum("credit")):
        data[r["account"]] = (r["c"] or ZERO) - (r["d"] or ZERO)  # credit-positive
    return data


def _pl_sections(organization, data):
    accounts = Account.objects.filter(organization=organization, pk__in=data.keys())
    sections = {"income": [], "cost_of_sales": [], "expenses": []}
    for a in accounts.order_by("code"):
        amount = data[a.pk]
        if a.account_type == AccountType.INCOME:
            sections["income"].append((a, amount))
        elif a.system_key in (SystemAccount.COGS, SystemAccount.PURCHASE_VARIANCE, SystemAccount.STOCK_ADJUSTMENT,
                              SystemAccount.FREIGHT_IN, SystemAccount.SERVICE_PURCHASES) or (a.parent and a.parent.code == "5000"):
            sections["cost_of_sales"].append((a, -amount))
        else:
            sections["expenses"].append((a, -amount))
    return sections


@report("profit-and-loss", "Profit and loss", "Financial", "reports.financial",
        "Income and expense account movements in the period from posted journals (year-end closing entries excluded). "
        "Revenue is recognised on invoice; cost of goods sold when stock is delivered. Gross profit = income − cost of "
        "sales; net profit = gross profit − operating expenses.")
def profit_and_loss(ctx):
    data = _pl_rows(ctx.organization, ctx.range.start, ctx.range.end)
    sections = _pl_sections(ctx.organization, data)
    rows = []
    totals = {}
    for key, title in (("income", "Income"), ("cost_of_sales", "Cost of sales"), ("expenses", "Operating expenses")):
        rows.append({"label": title, "amount": None, "style": "heading"})
        subtotal = ZERO
        for account, amount in sections[key]:
            rows.append({"code": account.code, "label": account.name, "amount": amount, "account_id": account.pk})
            subtotal += amount
        rows.append({"label": f"Total {title.lower()}", "amount": subtotal, "style": "subtotal"})
        totals[key] = subtotal
        if key == "cost_of_sales":
            rows.append({"label": "Gross profit", "amount": totals["income"] - subtotal, "style": "total"})
    net = totals["income"] - totals["cost_of_sales"] - totals["expenses"]
    rows.append({"label": "Net profit / (loss)", "amount": net, "style": "grand"})
    return {"columns": [col("code", "Code"), col("label", "Account"), col("amount", "Amount", "money")],
            "rows": rows, "totals": {}, "summary": {"income": totals["income"], "cost_of_sales": totals["cost_of_sales"],
                                                     "gross_profit": totals["income"] - totals["cost_of_sales"],
                                                     "expenses": totals["expenses"], "net_profit": net},
            "statement": True, "links": {"label": "accounts"}}


@report("balance-sheet", "Balance sheet", "Financial", "reports.financial",
        "Asset, liability and equity balances as of the date from posted journals. Profit not yet closed to retained "
        "earnings is shown as 'Current period profit' so the statement balances.", period="as_of")
def balance_sheet(ctx):
    qs = posted_lines(ctx.organization).filter(entry__date__lte=ctx.as_of)
    balances = {r["account"]: (r["d"] or ZERO) - (r["c"] or ZERO)
                for r in qs.values("account").annotate(d=Sum("debit"), c=Sum("credit"))}
    accounts = Account.objects.filter(organization=ctx.organization, pk__in=balances.keys()).order_by("code")
    groups = {AccountType.ASSET: [], AccountType.LIABILITY: [], AccountType.EQUITY: []}
    unclosed = ZERO
    for a in accounts:
        bal = balances[a.pk]
        if a.account_type in (AccountType.INCOME, AccountType.EXPENSE):
            unclosed -= bal
            continue
        groups[a.account_type].append((a, bal if a.account_type == AccountType.ASSET else -bal))
    rows, totals = [], {}
    for key, title in ((AccountType.ASSET, "Assets"), (AccountType.LIABILITY, "Liabilities"), (AccountType.EQUITY, "Equity")):
        rows.append({"label": title, "amount": None, "style": "heading"})
        subtotal = ZERO
        for account, amount in groups[key]:
            if amount == 0:
                continue
            rows.append({"code": account.code, "label": account.name, "amount": amount, "account_id": account.pk})
            subtotal += amount
        if key == AccountType.EQUITY and unclosed:
            rows.append({"label": "Current period profit (not yet closed)", "amount": unclosed})
            subtotal += unclosed
        rows.append({"label": f"Total {title.lower()}", "amount": subtotal, "style": "subtotal"})
        totals[key] = subtotal
    rows.append({"label": "Liabilities + equity", "amount": totals[AccountType.LIABILITY] + totals[AccountType.EQUITY], "style": "grand"})
    difference = totals[AccountType.ASSET] - totals[AccountType.LIABILITY] - totals[AccountType.EQUITY]
    return {"columns": [col("code", "Code"), col("label", "Account"), col("amount", "Amount", "money")],
            "rows": rows, "totals": {}, "statement": True,
            "summary": {"assets": totals[AccountType.ASSET], "liabilities": totals[AccountType.LIABILITY],
                        "equity": totals[AccountType.EQUITY], "difference": difference},
            "notes": [] if difference == 0 else [f"Out of balance by {difference}."], "links": {"label": "accounts"}}


@report("gross-profit", "Gross profit and COGS by period", "Financial", "reports.financial",
        "Net sales (Sales revenue − Sales returns accounts) and cost of goods sold (COGS account) per period from posted "
        "journals. Gross profit = net sales − COGS. Freight income and other cost-of-sales accounts are shown in the "
        "profit and loss statement.", params=[GROUP_PARAM])
def gross_profit(ctx):
    group = ctx.params.get("group", "bs_month")
    qs = posted_lines(ctx.organization).filter(**ctx.range.filter_kwargs("entry__date"),
                                               account__system_key__in=[SystemAccount.SALES, SystemAccount.SALES_RETURNS, SystemAccount.COGS]) \
        .exclude(entry__source=JournalSource.YEAR_END)
    buckets = OrderedDict()
    for line in qs.select_related("entry", "account").order_by("entry__date"):
        key, label = _bucket(line.entry.date, group)
        b = buckets.setdefault(key, {"period": label, "net_sales": ZERO, "cogs": ZERO})
        if line.account.system_key == SystemAccount.COGS:
            b["cogs"] += line.debit - line.credit
        else:
            b["net_sales"] += line.credit - line.debit
    rows = [buckets[k] for k in sorted(buckets)]
    for r in rows:
        r["gross_profit"] = r["net_sales"] - r["cogs"]
        r["margin"] = (r["gross_profit"] / r["net_sales"] * 100).quantize(Decimal("0.1")) if r["net_sales"] else None
    return {"columns": [col("period", "Period"), col("net_sales", "Net sales", "money"), col("cogs", "COGS", "money"),
                        col("gross_profit", "Gross profit", "money"), col("margin", "Margin %", "percent")],
            "rows": rows, "totals": _totals(rows, ["net_sales", "cogs", "gross_profit"]),
            "chart": {"type": "bar", "x": "period", "series": ["net_sales", "gross_profit"]}}


@report("expenses", "Expenses by category", "Financial", "reports.financial",
        "Posted expense vouchers in the period by category, before VAT; VAT is recoverable input tax.",
        params=[{"name": "detail", "label": "Show vouchers", "type": "boolean"}])
def expenses_report(ctx):
    from apps.expenses.models import Expense

    qs = Expense.objects.filter(organization=ctx.organization, status="POSTED", **ctx.range.filter_kwargs("date"))
    if ctx.params.get("detail") == "true":
        rows = [{"id": e.pk, "number": e.number, "date": e.date, "category": e.category.name, "payee": e.payee,
                 "description": e.description, "amount": e.amount, "tax": e.tax_amount, "total": e.total}
                for e in qs.select_related("category").order_by("date", "id")]
        return {"columns": [col("date", "Date", "date"), col("number", "Voucher"), col("category", "Category"),
                            col("payee", "Payee"), col("description", "Description"), col("amount", "Amount", "money"),
                            col("tax", "VAT", "money"), col("total", "Total", "money")],
                "rows": rows, "totals": _totals(rows, ["amount", "tax", "total"]), "links": {"number": "expenses"}}
    rows = [{"category": r["category__name"], "count": r["n"], "amount": r["a"], "tax": r["t"], "total": r["s"]}
            for r in qs.values("category__name").annotate(n=Count("id"), a=Sum("amount"), t=Sum("tax_amount"), s=Sum("total"))
            .order_by("-a")]
    return {"columns": [col("category", "Category"), col("count", "Vouchers", "number"), col("amount", "Amount", "money"),
                        col("tax", "VAT", "money"), col("total", "Total", "money")],
            "rows": rows, "totals": _totals(rows, ["count", "amount", "tax", "total"]),
            "chart": {"type": "bar", "x": "category", "series": ["amount"]}}


def _book(ctx, flag):
    from apps.accounting.ledgers import account_ledger

    account_id = ctx.params.get("account")
    accounts = Account.objects.filter(organization=ctx.organization, is_group=False, **{flag: True})
    if account_id:
        accounts = accounts.filter(pk=account_id)
    rows = []
    totals = {"debit": ZERO, "credit": ZERO}
    opening_total = closing_total = ZERO
    for account in accounts.order_by("code"):
        data = account_ledger(account, ctx.range.start, ctx.range.end)
        rows.append({"label": str(account), "style": "heading", "balance": data["opening_balance"], "narration": "Opening balance"})
        for r in data["rows"]:
            rows.append({"date": r["date"], "voucher": r["journal_number"], "document": r["source_number"],
                         "narration": r["narration"], "debit": r["debit"], "credit": r["credit"], "balance": r["balance"]})
        rows.append({"label": "", "style": "subtotal", "narration": "Closing balance", "debit": data["total_debit"],
                     "credit": data["total_credit"], "balance": data["closing_balance"]})
        totals["debit"] += data["total_debit"]
        totals["credit"] += data["total_credit"]
        opening_total += data["opening_balance"]
        closing_total += data["closing_balance"]
    return {"columns": [col("date", "Date", "date"), col("voucher", "Voucher"), col("document", "Document"),
                        col("narration", "Particulars"), col("debit", "Receipts (Dr)", "money"),
                        col("credit", "Payments (Cr)", "money"), col("balance", "Balance", "money")],
            "rows": rows, "totals": {**totals, "opening": opening_total, "closing": closing_total}}


ACCOUNT_PARAM_CASH = {"name": "account", "label": "Account", "type": "cash_account"}
ACCOUNT_PARAM_BANK = {"name": "account", "label": "Account", "type": "bank_account"}


@report("cashbook", "Cash book", "Financial", "reports.financial",
        "Every posted movement on cash accounts with running balance. Receipts are debits, payments are credits.",
        params=[ACCOUNT_PARAM_CASH])
def cashbook(ctx):
    return _book(ctx, "is_cash")


@report("bankbook", "Bank book", "Financial", "reports.financial",
        "Every posted movement on bank accounts with running balance (book balance, not the bank statement).",
        params=[ACCOUNT_PARAM_BANK])
def bankbook(ctx):
    return _book(ctx, "is_bank")


@report("tax-summary", "VAT summary", "Financial", "reports.financial",
        "Output VAT (VAT payable account credits less debits: invoices less credit notes) and input VAT (VAT receivable "
        "account: bills, expenses, less debit notes) per period from posted journals. Net payable = output − input. "
        "Operational summary only; verify against the applicable tax rules before filing.", params=[GROUP_PARAM])
def tax_summary(ctx):
    group = ctx.params.get("group", "bs_month")
    qs = posted_lines(ctx.organization).filter(**ctx.range.filter_kwargs("entry__date"),
                                               account__system_key__in=[SystemAccount.TAX_PAYABLE, SystemAccount.TAX_RECEIVABLE])
    buckets = OrderedDict()
    for line in qs.select_related("entry", "account").order_by("entry__date"):
        key, label = _bucket(line.entry.date, group)
        b = buckets.setdefault(key, {"period": label, "output_tax": ZERO, "input_tax": ZERO})
        if line.account.system_key == SystemAccount.TAX_PAYABLE:
            b["output_tax"] += line.credit - line.debit
        else:
            b["input_tax"] += line.debit - line.credit
    rows = [buckets[k] for k in sorted(buckets)]
    for r in rows:
        r["net_payable"] = r["output_tax"] - r["input_tax"]
    return {"columns": [col("period", "Period"), col("output_tax", "Output VAT", "money"), col("input_tax", "Input VAT", "money"),
                        col("net_payable", "Net payable", "money")],
            "rows": rows, "totals": _totals(rows, ["output_tax", "input_tax", "net_payable"])}


@report("general-ledger", "General ledger", "Financial", "reports.financial",
        "Posted journal lines in the period, grouped by account, with opening and closing balances.",
        params=[{"name": "account", "label": "Account", "type": "account"}])
def general_ledger(ctx):
    from apps.accounting.ledgers import account_ledger

    accounts = Account.objects.filter(organization=ctx.organization, is_group=False)
    if ctx.params.get("account"):
        accounts = accounts.filter(pk=ctx.params["account"])
    else:
        active = posted_lines(ctx.organization).filter(**ctx.range.filter_kwargs("entry__date")).values("account").distinct()
        accounts = accounts.filter(pk__in=active)
    rows = []
    for account in accounts.order_by("code"):
        data = account_ledger(account, ctx.range.start, ctx.range.end)
        rows.append({"label": str(account), "style": "heading", "balance": data["opening_balance"], "narration": "Opening balance"})
        for r in data["rows"]:
            rows.append({"date": r["date"], "voucher": r["journal_number"], "document": r["source_number"],
                         "narration": r["narration"], "debit": r["debit"], "credit": r["credit"], "balance": r["balance"]})
        rows.append({"style": "subtotal", "narration": "Closing balance", "debit": data["total_debit"], "credit": data["total_credit"],
                     "balance": data["closing_balance"]})
    return {"columns": [col("date", "Date", "date"), col("voucher", "Voucher"), col("document", "Document"),
                        col("narration", "Particulars"), col("debit", "Debit", "money"), col("credit", "Credit", "money"),
                        col("balance", "Balance", "money")],
            "rows": rows, "totals": {}}


@report("fiscal-year-comparison", "Fiscal year comparison", "Financial", "reports.financial",
        "Profit and loss figures for each fiscal year side by side (year-end closing entries excluded), so closed years "
        "remain comparable.", period="none")
def fiscal_year_comparison(ctx):
    from apps.fiscal_years.models import FiscalYear

    years = list(FiscalYear.objects.filter(organization=ctx.organization).exclude(status="DRAFT").order_by("start_date"))[-5:]
    metrics = OrderedDict([("income", "Income"), ("cost_of_sales", "Cost of sales"), ("gross_profit", "Gross profit"),
                           ("expenses", "Operating expenses"), ("net_profit", "Net profit")])
    values = {}
    for fy in years:
        sections = _pl_sections(ctx.organization, _pl_rows(ctx.organization, fy.start_date, fy.end_date))
        income = sum((a for _, a in sections["income"]), ZERO)
        cos = sum((a for _, a in sections["cost_of_sales"]), ZERO)
        exp = sum((a for _, a in sections["expenses"]), ZERO)
        values[fy.pk] = {"income": income, "cost_of_sales": cos, "gross_profit": income - cos, "expenses": exp,
                         "net_profit": income - cos - exp}
    rows = [{"label": label, **{f"fy_{fy.pk}": values[fy.pk][key] for fy in years}} for key, label in metrics.items()]
    return {"columns": [col("label", "")] + [col(f"fy_{fy.pk}", f"FY {fy.name}", "money") for fy in years],
            "rows": rows, "totals": {}}


@report("year-end-summary", "Year-end summary", "Financial", "reports.financial",
        "The stored summary of each completed year-end close (figures as validated at the time of closing).",
        period="none")
def year_end_summary(ctx):
    from apps.fiscal_years.models import FiscalYearClosing

    rows = []
    for c in FiscalYearClosing.objects.filter(fiscal_year__organization=ctx.organization).select_related(
            "fiscal_year", "closed_by", "closing_journal").order_by("-fiscal_year__start_date", "-id"):
        t = c.summary.get("totals", {})
        rows.append({"fiscal_year": c.fiscal_year.name, "closed_on": c.created_at.date(), "closed_by": c.closed_by.full_name,
                     "income": Decimal(t.get("income", "0")), "expenses": Decimal(t.get("expenses", "0")),
                     "net_profit": Decimal(t.get("net_profit", "0")), "inventory": Decimal(t.get("inventory_stock", "0")),
                     "receivables": Decimal(t.get("receivables", "0")), "payables": Decimal(t.get("payables", "0")),
                     "journal": c.closing_journal.number if c.closing_journal else "",
                     "status": "Reopened" if c.reopened_at else "Closed"})
    return {"columns": [col("fiscal_year", "Fiscal year"), col("closed_on", "Closed on", "date"), col("closed_by", "Closed by"),
                        col("income", "Income", "money"), col("expenses", "Expenses", "money"), col("net_profit", "Net profit", "money"),
                        col("inventory", "Inventory", "money"), col("receivables", "Receivables", "money"),
                        col("payables", "Payables", "money"), col("journal", "Closing journal"), col("status", "Status")],
            "rows": rows, "totals": {}}


@report("audit-trail", "Audit trail", "Audit", "audit.view",
        "Every recorded action in the period (append-only). Times are shown in the organisation timezone.",
        params=[{"name": "entity_type", "label": "Record type", "type": "text"}])
def audit_trail(ctx):
    from django.utils import timezone

    from apps.audit.models import AuditEvent

    qs = AuditEvent.objects.filter(organization=ctx.organization,
                                   **ctx.range.datetime_filter_kwargs("created_at", ctx.organization.timezone)).select_related("user")
    if ctx.params.get("entity_type"):
        qs = qs.filter(entity_type=ctx.params["entity_type"])
    rows = [{"time": timezone.localtime(e.created_at).strftime("%Y-%m-%d %H:%M"), "date": timezone.localtime(e.created_at).date(),
             "user": e.user.full_name if e.user else "System", "action": e.action, "entity": e.entity_type,
             "record": e.entity_label or e.entity_id, "reason": e.reason, "request_id": e.request_id}
            for e in qs.order_by("-created_at")[:5000]]
    return {"columns": [col("time", "Time"), col("date", "Date", "date"), col("user", "User"), col("action", "Action"),
                        col("entity", "Record type"), col("record", "Record"), col("reason", "Reason"), col("request_id", "Request ID")],
            "rows": rows, "totals": {}, "notes": ["Limited to the latest 5,000 events; narrow the date range for more."] if len(rows) == 5000 else []}
