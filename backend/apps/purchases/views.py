from drf_spectacular.utils import extend_schema
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.core.document_views import DocumentViewSet
from apps.core.permissions import check_warehouse_access
from apps.core.serializers import AllocationItemSerializer, ReasonSerializer

from . import services
from .models import GoodsReceipt, PurchaseOrder, PurchaseReturn, SupplierBill
from .serializers import (
    GoodsReceiptSerializer,
    PurchaseOrderListSerializer,
    PurchaseOrderSerializer,
    PurchaseReturnSerializer,
    SupplierBillListSerializer,
    SupplierBillSerializer,
)


class PurchaseOrderViewSet(DocumentViewSet):
    queryset = PurchaseOrder.objects.select_related("supplier", "warehouse", "submitted_by", "approved_by", "created_by") \
        .prefetch_related("lines__product__unit", "lines__tax_rate")
    serializer_class = PurchaseOrderSerializer
    permission_module = "purchases"
    permission_map = {"submit": "purchases.manage", "approve": "purchases.approve", "reject": "purchases.approve",
                      "cancel": ("purchases.manage", "purchases.approve"), "close": "purchases.approve",
                      "receivable": ("purchases.receive", "purchases.view"), "billable": ("purchases.bill", "purchases.view"),
                      "pdf": "purchases.view", "timeline": "purchases.view"}
    warehouse_field = "warehouse"
    audit_entity = "purchaseorder"
    entity_type = "purchaseorder"
    pdf_template = "documents/purchase_order.html"
    pdf_title = "Purchase Order"
    date_field = "order_date"
    search_fields = ["number", "supplier__name", "supplier__code", "supplier_reference"]
    filterset_fields = {"status": ["exact", "in"], "supplier": ["exact"], "warehouse": ["exact"]}
    ordering_fields = ["order_date", "number", "grand_total", "expected_delivery_date", "created_at"]
    ordering = ["-order_date", "-id"]

    def get_serializer_class(self):
        return PurchaseOrderListSerializer if self.action == "list" else PurchaseOrderSerializer

    def perform_create(self, serializer):
        check_warehouse_access(self.request, serializer.validated_data.get("warehouse"))
        super().perform_create(serializer)

    def _reason(self, request):
        data = ReasonSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        return data.validated_data["reason"]

    @extend_schema(request=None)
    @action(detail=True, methods=["post"])
    def submit(self, request, pk=None):
        return self.fresh(services.submit_po(self.get_object(), request.user, request=request))

    @extend_schema(request=None)
    @action(detail=True, methods=["post"])
    def approve(self, request, pk=None):
        return self.fresh(services.approve_po(self.get_object(), request.user, request=request))

    @extend_schema(request=ReasonSerializer)
    @action(detail=True, methods=["post"])
    def reject(self, request, pk=None):
        return self.fresh(services.reject_po(self.get_object(), request.user, self._reason(request), request=request))

    @extend_schema(request=ReasonSerializer)
    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        return self.fresh(services.cancel_po(self.get_object(), request.user, self._reason(request), request=request))

    @extend_schema(request=ReasonSerializer)
    @action(detail=True, methods=["post"])
    def close(self, request, pk=None):
        return self.fresh(services.close_po(self.get_object(), request.user, self._reason(request), request=request))

    @action(detail=True, methods=["get"])
    def receivable(self, request, pk=None):
        order = self.get_object()
        return Response([{"order_line": l.pk, "product": l.product_id, "sku": l.product.sku, "product_name": l.product.name,
                          "unit": l.product.unit.code, "ordered": l.quantity, "received": l.received_quantity,
                          "pending": l.quantity - l.received_quantity, "track_batches": l.product.track_batches,
                          "track_serials": l.product.track_serials, "track_expiry": l.product.track_expiry}
                         for l in order.lines.select_related("product", "product__unit")
                         if l.product.is_stock and l.quantity > l.received_quantity])

    @action(detail=True, methods=["get"])
    def billable(self, request, pk=None):
        """Received-but-unbilled GRN lines and unbilled service lines (prefill for a supplier bill)."""
        order = self.get_object()
        rows = [{"receipt_line": rl.pk, "grn_number": rl.receipt.number, "order_line": rl.order_line_id,
                 "product": rl.product_id, "sku": rl.product.sku, "product_name": rl.product.name, "quantity": qty,
                 "unit_price": rl.order_line.unit_price, "discount_percent": rl.order_line.discount_percent,
                 "tax_rate": rl.order_line.tax_rate_id} for rl, qty in services.billable_receipt_lines(order)]
        for line in order.lines.select_related("product"):
            if not line.product.is_stock and line.quantity > line.billed_quantity:
                rows.append({"receipt_line": None, "grn_number": None, "order_line": line.pk, "product": line.product_id,
                             "sku": line.product.sku, "product_name": line.product.name,
                             "quantity": line.quantity - line.billed_quantity, "unit_price": line.unit_price,
                             "discount_percent": line.discount_percent, "tax_rate": line.tax_rate_id})
        return Response(rows)


class GoodsReceiptViewSet(DocumentViewSet):
    queryset = GoodsReceipt.objects.select_related("purchase_order", "supplier", "warehouse", "received_by") \
        .prefetch_related("lines__product__unit", "lines__order_line")
    serializer_class = GoodsReceiptSerializer
    permission_module = "purchases"
    permission_map = {"create": "purchases.receive", "update": "purchases.receive", "partial_update": "purchases.receive",
                      "destroy": "purchases.receive", "post_document": "purchases.receive", "reverse": "purchases.receive",
                      "pdf": "purchases.view", "timeline": "purchases.view"}
    warehouse_field = "warehouse"
    audit_entity = "goodsreceipt"
    entity_type = "goodsreceipt"
    pdf_template = "documents/goods_receipt.html"
    pdf_title = "Goods Received Note"
    date_field = "date"
    search_fields = ["number", "supplier__name", "purchase_order__number", "supplier_delivery_note"]
    filterset_fields = {"status": ["exact", "in"], "supplier": ["exact"], "purchase_order": ["exact"], "warehouse": ["exact"]}
    ordering = ["-date", "-id"]

    @extend_schema(request=None)
    @action(detail=True, methods=["post"], url_path="post")
    def post_document(self, request, pk=None):
        grn = self.get_object()
        check_warehouse_access(request, grn.warehouse)
        return self.fresh(services.post_grn(grn, request.user, request=request))

    @extend_schema(request=ReasonSerializer)
    @action(detail=True, methods=["post"])
    def reverse(self, request, pk=None):
        data = ReasonSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        return self.fresh(services.reverse_grn(self.get_object(), request.user, data.validated_data["reason"], request=request))


class SupplierBillViewSet(DocumentViewSet):
    queryset = SupplierBill.objects.select_related("supplier", "purchase_order", "warehouse", "fiscal_year", "posted_by") \
        .prefetch_related("lines__product__unit", "lines__tax_rate", "lines__receipt_line__receipt")
    serializer_class = SupplierBillSerializer
    permission_module = "purchases"
    permission_map = {"create": "purchases.bill", "update": "purchases.bill", "partial_update": "purchases.bill",
                      "destroy": "purchases.bill", "post_document": "purchases.bill", "reverse": "accounting.reverse",
                      "pdf": "purchases.view", "timeline": "purchases.view", "allocations": "purchases.view"}
    audit_entity = "supplierbill"
    entity_type = "supplierbill"
    pdf_template = "documents/supplier_bill.html"
    pdf_title = "Supplier Bill"
    date_field = "bill_date"
    search_fields = ["number", "supplier__name", "supplier_invoice_number", "purchase_order__number"]
    filterset_fields = {"status": ["exact", "in"], "payment_status": ["exact", "in"], "supplier": ["exact"],
                        "purchase_order": ["exact"], "fiscal_year": ["exact"]}
    ordering_fields = ["bill_date", "due_date", "number", "grand_total", "balance_due", "created_at"]
    ordering = ["-bill_date", "-id"]

    def get_serializer_class(self):
        return SupplierBillListSerializer if self.action == "list" else SupplierBillSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request.query_params.get("open") == "true":
            qs = qs.filter(status="POSTED", balance_due__gt=0)
        if self.request.query_params.get("overdue") == "true":
            from django.utils import timezone

            qs = qs.filter(status="POSTED", balance_due__gt=0, due_date__lt=timezone.localdate())
        return qs

    def pdf_context(self, obj):
        return {"tax_breakdown": obj.tax_breakdown()}

    @extend_schema(request=None)
    @action(detail=True, methods=["post"], url_path="post")
    def post_document(self, request, pk=None):
        return self.fresh(services.post_bill(self.get_object(), request.user, request=request))

    @extend_schema(request=ReasonSerializer)
    @action(detail=True, methods=["post"])
    def reverse(self, request, pk=None):
        data = ReasonSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        return self.fresh(services.reverse_bill(self.get_object(), request.user, data.validated_data["reason"], request=request))

    @action(detail=True, methods=["get"])
    def allocations(self, request, pk=None):
        bill = self.get_object()
        rows = []
        for a in bill.allocations.select_related("voucher", "debit_note").order_by("date", "id"):
            source = a.voucher or a.debit_note
            rows.append({"id": a.pk, "date": a.date, "amount": a.amount, "is_active": a.is_active,
                         "source_type": "voucher" if a.voucher_id else "debit_note", "source_id": source.pk,
                         "source_number": source.number, "reversed_at": a.reversed_at})
        return Response(rows)


class PurchaseReturnViewSet(DocumentViewSet):
    queryset = PurchaseReturn.objects.select_related("bill", "supplier", "warehouse").prefetch_related(
        "lines__product__unit", "lines__tax_rate")
    serializer_class = PurchaseReturnSerializer
    permission_module = "purchases"
    permission_map = {"create": "purchases.return", "update": "purchases.return", "partial_update": "purchases.return",
                      "destroy": "purchases.return", "post_document": "purchases.return", "apply": "purchases.payment",
                      "pdf": "purchases.view", "timeline": "purchases.view"}
    audit_entity = "purchasereturn"
    entity_type = "purchasereturn"
    pdf_template = "documents/debit_note.html"
    pdf_title = "Purchase Return / Debit Note"
    date_field = "date"
    search_fields = ["number", "supplier__name", "bill__number", "reason"]
    filterset_fields = {"status": ["exact"], "supplier": ["exact"], "bill": ["exact"]}
    ordering = ["-date", "-id"]

    def pdf_context(self, obj):
        return {"tax_breakdown": obj.tax_breakdown()}

    @extend_schema(request=None)
    @action(detail=True, methods=["post"], url_path="post")
    def post_document(self, request, pk=None):
        return self.fresh(services.post_purchase_return(self.get_object(), request.user, request=request))

    @extend_schema(request=AllocationItemSerializer(many=True))
    @action(detail=True, methods=["post"])
    def apply(self, request, pk=None):
        from apps.payments.services import allocate_debit_note

        items = AllocationItemSerializer(data=request.data.get("allocations", []), many=True)
        items.is_valid(raise_exception=True)
        allocate_debit_note(self.get_object(), [(i["document"], i["amount"]) for i in items.validated_data], request.user,
                            request=request)
        return self.fresh(self.get_object())
