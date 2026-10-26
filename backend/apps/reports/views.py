import datetime as dt
from decimal import Decimal

from django.db.models import Count, F, Q, Sum
from django.utils import timezone
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.response import Response

from apps.audit.services import record_event
from apps.calendar_utils.fields import bs_or_none, parse_date_input
from apps.calendar_utils.ranges import resolve_date_range
from apps.core.export import export_response
from apps.core.money import ZERO
from apps.core.pdf import pdf_response, render_pdf
from apps.core.permissions import HasModulePermission

from . import definitions  # noqa: F401  (registers reports)
from .definitions import Ctx
from .registry import REPORTS


@api_view(["GET"])
@permission_classes([HasModulePermission])
def report_index(request):
    groups = {}
    for r in REPORTS.values():
        if r.permission in request.perms:
            groups.setdefault(r.group, []).append({"slug": r.slug, "title": r.title, "basis": r.basis, "params": r.params,
                                                   "period": r.period})
    return Response([{"group": g, "reports": items} for g, items in groups.items()])


def _jsonable(value):
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (dt.date, dt.datetime)):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_jsonable(v) for v in value]
    return value


def run_report(request, slug):
    definition = REPORTS.get(slug)
    if definition is None:
        raise NotFound("Unknown report.")
    if definition.permission not in request.perms:
        raise PermissionDenied("Your role cannot view this report.")
    params = request.query_params
    date_range = resolve_date_range(params, request.organization, default_to_current_fy=definition.period == "range")
    as_of = parse_date_input(params.get("as_of"), params.get("as_of_bs"), "as_of") or date_range.end or timezone.localdate()
    if definition.period == "as_of" and params.get("fiscal_year") and not params.get("as_of"):
        as_of = date_range.end
    ctx = Ctx(organization=request.organization, range=date_range, params=params, as_of=as_of, user=request.user)
    data = definition.func(ctx)
    data.update({"slug": slug, "title": definition.title, "basis": definition.basis, "period": definition.period,
                 "range": date_range.as_dict(), "as_of": as_of.isoformat() if as_of else None, "as_of_bs": bs_or_none(as_of),
                 "generated_at": timezone.now().isoformat()})
    # Add BS values for every date column so clients and exports never convert on their own.
    date_keys = [c["key"] for c in data["columns"] if c["type"] == "date"]
    for row in data["rows"]:
        for key in date_keys:
            if row.get(key):
                row[f"{key}_bs"] = bs_or_none(row[key])
    return definition, data


@api_view(["GET"])
@permission_classes([HasModulePermission])
def report_detail(request, slug):
    definition, data = run_report(request, slug)
    fmt = request.query_params.get("export")
    if fmt in ("csv", "xlsx"):
        record_event(request, "report.exported", "report", entity_id=slug, label=definition.title, new={"format": fmt})
        rows = [r for r in data["rows"]]
        if data.get("totals"):
            rows = rows + [{**{c["key"]: "" for c in data["columns"]}, **data["totals"], data["columns"][0]["key"]: "Total"}]
        period_label = (f"{data['range']['start'] or ''} – {data['range']['end'] or ''}" if definition.period == "range"
                        else f"As of {data['as_of']}" if definition.period == "as_of" else "")
        return export_response(rows, [(c["key"], c["label"], {"percent": "number"}.get(c["type"], c["type"])) for c in data["columns"]],
                               slug, fmt, title=f"{request.organization.name} – {definition.title}",
                               meta={"Period": period_label, "Basis": definition.basis})
    if fmt == "pdf":
        record_event(request, "report.exported", "report", entity_id=slug, label=definition.title, new={"format": "pdf"})
        pdf = render_pdf("documents/report.html", {"organization": request.organization, "report": data,
                                                   "landscape": len(data["columns"]) > 7}, request)
        return pdf_response(pdf, f"{slug}.pdf")
    return Response(_jsonable(data))


@api_view(["GET"])
@permission_classes([HasModulePermission])
def dashboard(request):
    """Key figures for the dashboard. Every number comes from posted records; sections respect permissions."""
    from apps.accounting.models import Account, SystemAccount
    from apps.accounting.services import posted_lines
    from apps.fiscal_years.models import FiscalYear

    org = request.organization
    perms = request.perms
    today = timezone.localdate()
    fy = FiscalYear.resolve(org, request.query_params.get("fiscal_year") or "current")
    date_range = resolve_date_range(request.query_params, org, default_to_current_fy=True)
    start, end = date_range.start, date_range.end or today
    out = {"today": today.isoformat(), "today_bs": bs_or_none(today),
           "fiscal_year": {"id": fy.pk, "name": fy.name} if fy else None, "range": date_range.as_dict()}

    if "reports.sales" in perms or "sales.view" in perms:
        from apps.sales.models import SalesInvoice, SalesOrder, SalesReturn

        invoices = SalesInvoice.objects.filter(organization=org, status="POSTED")
        returns = SalesReturn.objects.filter(organization=org, status="POSTED")
        period_sales = (invoices.filter(invoice_date__range=(start, end)).aggregate(s=Sum("taxable_total"))["s"] or ZERO) - (
            returns.filter(date__range=(start, end)).aggregate(s=Sum("taxable_total"))["s"] or ZERO)
        out["sales"] = {
            "today": invoices.filter(invoice_date=today).aggregate(s=Sum("taxable_total"))["s"] or ZERO,
            "today_count": invoices.filter(invoice_date=today).count(),
            "period": period_sales,
            "pending_orders": SalesOrder.objects.filter(organization=org, status__in=["APPROVED", "PARTIAL"]).count(),
            "awaiting_approval": SalesOrder.objects.filter(organization=org, status="SUBMITTED").count(),
            "overdue_count": invoices.filter(balance_due__gt=0, due_date__lt=today).count(),
            "overdue_amount": invoices.filter(balance_due__gt=0, due_date__lt=today).aggregate(s=Sum("balance_due"))["s"] or ZERO,
        }
        out["recent_invoices"] = [
            {"id": i.pk, "number": i.number, "customer": i.customer.name, "date": i.invoice_date, "date_bs": bs_or_none(i.invoice_date),
             "total": i.grand_total, "balance_due": i.balance_due, "payment_status": i.payment_status}
            for i in invoices.select_related("customer").order_by("-invoice_date", "-id")[:8]
        ]
        top = (SalesInvoice.objects.filter(organization=org, status="POSTED", invoice_date__range=(start, end))
               .values("lines__product__name", "lines__product").annotate(v=Sum("lines__taxable_amount"), q=Sum("lines__quantity"))
               .order_by("-v")[:6])
        out["top_products"] = [{"product_id": r["lines__product"], "product": r["lines__product__name"], "revenue": r["v"],
                                "quantity": r["q"]} for r in top if r["lines__product"]]
        top_customers = (invoices.filter(invoice_date__range=(start, end)).values("customer", "customer__name")
                         .annotate(v=Sum("taxable_total")).order_by("-v")[:6])
        out["top_customers"] = [{"customer_id": r["customer"], "customer": r["customer__name"], "revenue": r["v"]} for r in top_customers]

    if "reports.purchases" in perms or "purchases.view" in perms:
        from apps.purchases.models import PurchaseOrder, SupplierBill

        bills = SupplierBill.objects.filter(organization=org, status="POSTED")
        out["purchases"] = {
            "period": bills.filter(bill_date__range=(start, end)).aggregate(s=Sum("taxable_total"))["s"] or ZERO,
            "pending_orders": PurchaseOrder.objects.filter(organization=org, status__in=["APPROVED", "PARTIAL"]).count(),
            "awaiting_approval": PurchaseOrder.objects.filter(organization=org, status="SUBMITTED").count(),
            "overdue_amount": bills.filter(balance_due__gt=0, due_date__lt=today).aggregate(s=Sum("balance_due"))["s"] or ZERO,
        }

    if "reports.financial" in perms or "accounting.view" in perms:
        lines = posted_lines(org)

        def control(key, credit=False):
            agg = lines.filter(account__system_key=key, entry__date__lte=today).aggregate(d=Sum("debit"), c=Sum("credit"))
            net = (agg["d"] or ZERO) - (agg["c"] or ZERO)
            return -net if credit else net

        period_lines = lines.filter(entry__date__range=(start, end)).exclude(entry__source="YEAR_END")
        sales_net = period_lines.filter(account__system_key__in=[SystemAccount.SALES, SystemAccount.SALES_RETURNS]).aggregate(
            d=Sum("debit"), c=Sum("credit"))
        cogs = period_lines.filter(account__system_key=SystemAccount.COGS).aggregate(d=Sum("debit"), c=Sum("credit"))
        net_sales = (sales_net["c"] or ZERO) - (sales_net["d"] or ZERO)
        cogs_value = (cogs["d"] or ZERO) - (cogs["c"] or ZERO)
        cash_accounts = Account.objects.filter(organization=org, is_group=False).filter(Q(is_cash=True) | Q(is_bank=True))
        balances = {r["account"]: (r["d"] or ZERO) - (r["c"] or ZERO) for r in lines.filter(account__in=cash_accounts)
                    .values("account").annotate(d=Sum("debit"), c=Sum("credit"))}
        out["finance"] = {
            "receivables": control(SystemAccount.RECEIVABLE),
            "payables": control(SystemAccount.PAYABLE, credit=True),
            "gross_profit": net_sales - cogs_value,
            "net_sales": net_sales,
            "cogs": cogs_value,
            "cash_and_bank": [{"id": a.pk, "name": a.name, "is_bank": a.is_bank, "balance": balances.get(a.pk, ZERO)}
                              for a in cash_accounts.order_by("code")],
        }
        out["finance"]["cash_total"] = sum((a["balance"] for a in out["finance"]["cash_and_bank"]), ZERO)

    if "inventory.view" in perms or "reports.inventory" in perms:
        from apps.inventory.models import StockBalance
        from apps.products.models import Product

        out["inventory"] = {
            "value": StockBalance.objects.filter(organization=org).aggregate(s=Sum("value"))["s"] or ZERO,
            "sku_in_stock": StockBalance.objects.filter(organization=org, on_hand__gt=0, warehouse__is_transit=False)
            .values("product").distinct().count(),
        }
        totals = {r["product"]: r["q"] for r in StockBalance.objects.filter(organization=org, warehouse__is_transit=False)
                  .values("product").annotate(q=Sum("on_hand"))}
        low = []
        for p in Product.objects.filter(organization=org, is_active=True, product_type="STOCK", reorder_level__gt=0).select_related("unit"):
            on_hand = totals.get(p.pk, ZERO)
            if on_hand <= p.reorder_level:
                low.append({"id": p.pk, "sku": p.sku, "name": p.name, "unit": p.unit.code, "on_hand": on_hand,
                            "reorder_level": p.reorder_level})
        low.sort(key=lambda r: r["on_hand"] - r["reorder_level"])
        out["inventory"]["low_stock_count"] = len(low)
        out["low_stock"] = low[:8]

    if "expenses.view" in perms:
        from apps.expenses.models import Expense

        out["expenses"] = {
            "period": Expense.objects.filter(organization=org, status="POSTED", date__range=(start, end)).aggregate(s=Sum("amount"))["s"] or ZERO,
            "awaiting_approval": Expense.objects.filter(organization=org, status="SUBMITTED").count(),
        }

    # Monthly trend (BS months of the selected range) for sales and purchases.
    if "sales" in out or "purchases" in out:
        from apps.reports.definitions import _bucket
        from apps.purchases.models import SupplierBill
        from apps.sales.models import SalesInvoice

        trend = {}
        if "sales" in out:
            for inv in SalesInvoice.objects.filter(organization=org, status="POSTED", invoice_date__range=(start, end)) \
                    .values("invoice_date").annotate(s=Sum("taxable_total")):
                key, label = _bucket(inv["invoice_date"], "bs_month")
                trend.setdefault(key, {"period": label, "sales": ZERO, "purchases": ZERO})["sales"] += inv["s"]
        if "purchases" in out:
            for bill in SupplierBill.objects.filter(organization=org, status="POSTED", bill_date__range=(start, end)) \
                    .values("bill_date").annotate(s=Sum("taxable_total")):
                key, label = _bucket(bill["bill_date"], "bs_month")
                trend.setdefault(key, {"period": label, "sales": ZERO, "purchases": ZERO})["purchases"] += bill["s"]
        out["trend"] = [trend[k] for k in sorted(trend)]

    approvals = []
    if "sales.approve" in perms:
        from apps.sales.models import SalesOrder

        approvals += [{"type": "sales-order", "id": o.pk, "number": o.number, "party": o.customer.name, "amount": o.grand_total,
                       "date": o.order_date} for o in SalesOrder.objects.filter(organization=org, status="SUBMITTED").select_related("customer")[:10]]
    if "purchases.approve" in perms:
        from apps.purchases.models import PurchaseOrder

        approvals += [{"type": "purchase-order", "id": o.pk, "number": o.number, "party": o.supplier.name, "amount": o.grand_total,
                       "date": o.order_date} for o in PurchaseOrder.objects.filter(organization=org, status="SUBMITTED").select_related("supplier")[:10]]
    if "expenses.approve" in perms:
        from apps.expenses.models import Expense

        approvals += [{"type": "expense", "id": e.pk, "number": e.number or f"Draft #{e.pk}", "party": e.payee, "amount": e.total,
                       "date": e.date} for e in Expense.objects.filter(organization=org, status="SUBMITTED")[:10]]
    if "purchases.payment" in perms:
        from apps.payments.models import PaymentVoucher

        approvals += [{"type": "payment-voucher", "id": v.pk, "number": f"Draft #{v.pk}", "party": v.supplier.name,
                       "amount": v.amount, "date": v.date}
                      for v in PaymentVoucher.objects.filter(organization=org, status="DRAFT").select_related("supplier")[:10]]
    out["approvals"] = approvals
    return Response(_jsonable(out))
