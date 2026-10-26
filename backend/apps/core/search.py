"""Global search across master data and documents the user is allowed to see."""
from django.db.models import Q
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from .permissions import HasModulePermission

TARGETS = [
    # (permission, type, model path, search fields, label fields)
    ("customers.view", "customer", "customers.Customer", ["code", "name", "phone", "tax_id"], ("code", "name")),
    ("suppliers.view", "supplier", "suppliers.Supplier", ["code", "name", "phone", "tax_id"], ("code", "name")),
    ("products.view", "product", "products.Product", ["sku", "name", "barcode"], ("sku", "name")),
    ("sales.view", "sales-order", "sales.SalesOrder", ["number", "customer__name"], ("number", "customer__name")),
    ("sales.view", "sales-invoice", "sales.SalesInvoice", ["number", "customer__name"], ("number", "customer__name")),
    ("sales.view", "sales-receipt", "payments.CustomerReceipt", ["number", "customer__name", "reference"], ("number", "customer__name")),
    ("purchases.view", "purchase-order", "purchases.PurchaseOrder", ["number", "supplier__name"], ("number", "supplier__name")),
    ("purchases.view", "purchase-bill", "purchases.SupplierBill", ["number", "supplier_invoice_number", "supplier__name"],
     ("number", "supplier__name")),
    ("purchases.view", "payment-voucher", "payments.PaymentVoucher", ["number", "supplier__name", "reference"], ("number", "supplier__name")),
    ("expenses.view", "expense", "expenses.Expense", ["number", "payee"], ("number", "payee")),
    ("accounting.view", "journal", "accounting.JournalEntry", ["number", "narration"], ("number", "narration")),
]


@api_view(["GET"])
@permission_classes([HasModulePermission])
def global_search(request):
    from django.apps import apps

    q = (request.query_params.get("q") or "").strip()
    if len(q) < 2:
        return Response([])
    results = []
    for perm, kind, model_path, fields, label_fields in TARGETS:
        if perm not in request.perms:
            continue
        model = apps.get_model(model_path)
        cond = Q()
        for f in fields:
            cond |= Q(**{f"{f}__icontains": q})
        for row in model.objects.filter(organization=request.organization).filter(cond).exclude(
                **({"number": ""} if kind not in ("customer", "supplier", "product") else {})).values("id", *label_fields)[:5]:
            title, sub = row[label_fields[0]], row[label_fields[1]]
            results.append({"type": kind, "id": row["id"], "title": title, "subtitle": sub})
    return Response(results[:30])
