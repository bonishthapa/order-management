"""Ledgers and aging derived from posted journal lines and allocations."""
import datetime as dt

from django.db.models import Sum

from apps.calendar_utils.fields import bs_or_none
from apps.core.money import ZERO

from .models import SystemAccount
from .services import posted_lines

SOURCE_LINKS = {
    "SALES_INVOICE": "sales-invoices", "CUSTOMER_RECEIPT": "sales-receipts", "CUSTOMER_REFUND": "customer-refunds",
    "SALES_RETURN": "sales-returns", "DELIVERY": "deliveries", "GOODS_RECEIPT": "goods-received-notes",
    "PURCHASE_BILL": "purchase-bills", "PAYMENT_VOUCHER": "payment-vouchers", "SUPPLIER_REFUND": "supplier-refunds",
    "PURCHASE_RETURN": "purchase-returns", "EXPENSE": "expenses", "STOCK": "stock-movements",
}


def _rows(qs, debit_positive=True):
    rows = []
    for line in qs.select_related("entry").order_by("entry__date", "entry__id", "id"):
        e = line.entry
        rows.append({
            "date": e.date, "date_bs": bs_or_none(e.date), "journal_id": e.pk, "journal_number": e.number,
            "source": e.source, "source_id": e.source_id, "source_number": e.source_number,
            "source_link": SOURCE_LINKS.get(e.source), "narration": line.description or e.narration,
            "debit": line.debit, "credit": line.credit,
        })
    return rows


def ledger(qs, *, start=None, end=None, credit_normal=False):
    """Opening balance, running rows and closing balance for a filtered journal-line queryset."""
    sign = -1 if credit_normal else 1
    opening = ZERO
    if start:
        agg = qs.filter(entry__date__lt=start).aggregate(d=Sum("debit"), c=Sum("credit"))
        opening = sign * ((agg["d"] or ZERO) - (agg["c"] or ZERO))
    period = qs
    if start:
        period = period.filter(entry__date__gte=start)
    if end:
        period = period.filter(entry__date__lte=end)
    rows = _rows(period)
    balance = opening
    total_debit = total_credit = ZERO
    for row in rows:
        balance += sign * (row["debit"] - row["credit"])
        row["balance"] = balance
        total_debit += row["debit"]
        total_credit += row["credit"]
    return {"opening_balance": opening, "rows": rows, "total_debit": total_debit, "total_credit": total_credit,
            "closing_balance": balance}


def customer_ledger(customer, start=None, end=None):
    qs = posted_lines(customer.organization).filter(customer=customer, account__system_key=SystemAccount.RECEIVABLE)
    return ledger(qs, start=start, end=end)


def supplier_ledger(supplier, start=None, end=None):
    qs = posted_lines(supplier.organization).filter(supplier=supplier, account__system_key=SystemAccount.PAYABLE)
    return ledger(qs, start=start, end=end, credit_normal=True)


def account_ledger(account, start=None, end=None):
    qs = posted_lines(account.organization).filter(account=account)
    return ledger(qs, start=start, end=end, credit_normal=not account.is_debit_normal)


BUCKETS = [("current", "Not due"), ("d1_30", "1–30 days"), ("d31_60", "31–60 days"), ("d61_90", "61–90 days"), ("d90_plus", "Over 90 days")]


def _bucket(days_overdue):
    if days_overdue <= 0:
        return "current"
    if days_overdue <= 30:
        return "d1_30"
    if days_overdue <= 60:
        return "d31_60"
    if days_overdue <= 90:
        return "d61_90"
    return "d90_plus"


def receivable_aging(organization, as_of: dt.date, customer=None):
    """Open invoice balances as of a date (allocations dated after ``as_of`` are ignored)."""
    from apps.payments.models import InvoiceAllocation
    from apps.sales.models import SalesInvoice

    invoices = SalesInvoice.objects.filter(organization=organization, invoice_date__lte=as_of, status__in=["POSTED", "REVERSED"])
    invoices = invoices.exclude(status="REVERSED", updated_at__date__lte=as_of)
    if customer is not None:
        invoices = invoices.filter(customer=customer)
    allocated = {
        row["invoice"]: row["s"]
        for row in InvoiceAllocation.objects.filter(organization=organization, date__lte=as_of, is_active=True)
        .values("invoice").annotate(s=Sum("amount"))
    }
    return _aging(invoices.select_related("customer"), allocated, as_of, "customer", "invoice_date")


def payable_aging(organization, as_of: dt.date, supplier=None):
    from apps.payments.models import BillAllocation
    from apps.purchases.models import SupplierBill

    bills = SupplierBill.objects.filter(organization=organization, bill_date__lte=as_of, status__in=["POSTED", "REVERSED"])
    bills = bills.exclude(status="REVERSED", updated_at__date__lte=as_of)
    if supplier is not None:
        bills = bills.filter(supplier=supplier)
    allocated = {
        row["bill"]: row["s"]
        for row in BillAllocation.objects.filter(organization=organization, date__lte=as_of, is_active=True)
        .values("bill").annotate(s=Sum("amount"))
    }
    return _aging(bills.select_related("supplier"), allocated, as_of, "supplier", "bill_date")


def _aging(documents, allocated, as_of, party_attr, date_attr):
    parties = {}
    details = []
    for doc in documents:
        outstanding = doc.grand_total - allocated.get(doc.pk, ZERO)
        if outstanding <= 0:
            continue
        days = (as_of - doc.due_date).days
        bucket = _bucket(days)
        party = getattr(doc, party_attr)
        entry = parties.setdefault(party.pk, {"party_id": party.pk, "party_code": party.code, "party_name": party.name,
                                               **{key: ZERO for key, _ in BUCKETS}, "total": ZERO})
        entry[bucket] += outstanding
        entry["total"] += outstanding
        details.append({"id": doc.pk, "number": doc.number, "party_id": party.pk, "party_name": party.name,
                        "date": getattr(doc, date_attr), "due_date": doc.due_date, "days_overdue": max(days, 0),
                        "bucket": bucket, "total": doc.grand_total, "outstanding": outstanding})
    totals = {key: sum((p[key] for p in parties.values()), ZERO) for key, _ in BUCKETS}
    totals["total"] = sum((p["total"] for p in parties.values()), ZERO)
    return {"as_of": as_of, "buckets": [{"key": k, "label": l} for k, l in BUCKETS],
            "parties": sorted(parties.values(), key=lambda p: -p["total"]), "documents": details, "totals": totals}
