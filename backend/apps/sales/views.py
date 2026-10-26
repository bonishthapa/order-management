from drf_spectacular.utils import extend_schema
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.core.document_views import DocumentViewSet
from apps.core.permissions import check_warehouse_access
from apps.core.serializers import AllocationItemSerializer, ReasonSerializer

from . import services
from .models import Delivery, SalesInvoice, SalesOrder, SalesReturn
from .serializers import (
    DeliverySerializer,
    SalesInvoiceListSerializer,
    SalesInvoiceSerializer,
    SalesOrderListSerializer,
    SalesOrderSerializer,
    SalesReturnSerializer,
)


class ApproveSerializer(serializers.Serializer):
    override_credit_limit = serializers.BooleanField(default=False)


class SalesOrderViewSet(DocumentViewSet):
    queryset = SalesOrder.objects.select_related("customer", "warehouse", "submitted_by", "approved_by", "created_by") \
        .prefetch_related("lines__product__unit", "lines__tax_rate")
    serializer_class = SalesOrderSerializer
    permission_module = "sales"
    permission_map = {"submit": "sales.manage", "approve": "sales.approve", "reject": "sales.approve",
                      "cancel": ("sales.manage", "sales.approve"), "close": "sales.approve", "reserve": "sales.approve",
                      "invoiceable": ("sales.invoice", "sales.view"), "deliverable": ("sales.deliver", "sales.view"),
                      "pdf": "sales.view", "timeline": "sales.view"}
    warehouse_field = "warehouse"
    audit_entity = "salesorder"
    entity_type = "salesorder"
    pdf_template = "documents/sales_order.html"
    pdf_title = "Sales Order"
    date_field = "order_date"
    search_fields = ["number", "customer__name", "customer__code", "customer_reference"]
    filterset_fields = {"status": ["exact", "in"], "customer": ["exact"], "warehouse": ["exact"]}
    ordering_fields = ["order_date", "number", "grand_total", "expected_delivery_date", "created_at"]
    ordering = ["-order_date", "-id"]

    def get_serializer_class(self):
        return SalesOrderListSerializer if self.action == "list" else SalesOrderSerializer

    def perform_create(self, serializer):
        check_warehouse_access(self.request, serializer.validated_data.get("warehouse"))
        super().perform_create(serializer)

    @extend_schema(request=None)
    @action(detail=True, methods=["post"])
    def submit(self, request, pk=None):
        return self.fresh(services.submit_order(self.get_object(), request.user, request=request))

    @extend_schema(request=ApproveSerializer)
    @action(detail=True, methods=["post"])
    def approve(self, request, pk=None):
        data = ApproveSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        return self.fresh(services.approve_order(self.get_object(), request.user,
                                                 override_credit_limit=data.validated_data["override_credit_limit"], request=request))

    @extend_schema(request=ReasonSerializer)
    @action(detail=True, methods=["post"])
    def reject(self, request, pk=None):
        data = ReasonSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        return self.fresh(services.reject_order(self.get_object(), request.user, data.validated_data["reason"], request=request))

    @extend_schema(request=ReasonSerializer)
    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        data = ReasonSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        return self.fresh(services.cancel_order(self.get_object(), request.user, data.validated_data["reason"], request=request))

    @extend_schema(request=ReasonSerializer)
    @action(detail=True, methods=["post"])
    def close(self, request, pk=None):
        data = ReasonSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        return self.fresh(services.close_order(self.get_object(), request.user, data.validated_data["reason"], request=request))

    @extend_schema(request=None)
    @action(detail=True, methods=["post"])
    def reserve(self, request, pk=None):
        return self.fresh(services.rereserve_order(self.get_object(), request.user, request=request))

    @action(detail=True, methods=["get"])
    def invoiceable(self, request, pk=None):
        """Lines and quantities that can be invoiced now (prefill for a new invoice)."""
        order = self.get_object()
        return Response([{"order_line": line.pk, "product": line.product_id, "sku": line.product.sku,
                          "product_name": line.product.name, "description": line.description, "quantity": qty,
                          "unit_price": line.unit_price, "discount_percent": line.discount_percent,
                          "tax_rate": line.tax_rate_id} for line, qty in services.invoiceable_lines(order)])

    @action(detail=True, methods=["get"])
    def deliverable(self, request, pk=None):
        order = self.get_object()
        from apps.inventory.models import StockBalance

        result = []
        for line in order.lines.select_related("product", "product__unit"):
            remaining = line.quantity - line.delivered_quantity
            if remaining <= 0:
                continue
            balance = StockBalance.objects.filter(product=line.product, warehouse=order.warehouse).first()
            result.append({"order_line": line.pk, "product": line.product_id, "sku": line.product.sku,
                           "product_name": line.product.name, "unit": line.product.unit.code, "is_stock": line.product.is_stock,
                           "remaining": remaining, "reserved": line.reserved_quantity,
                           "on_hand": balance.on_hand if balance else 0,
                           "available": (balance.available + line.reserved_quantity) if balance else line.reserved_quantity,
                           "track_batches": line.product.track_batches, "track_serials": line.product.track_serials})
        return Response(result)


class DeliveryViewSet(DocumentViewSet):
    queryset = Delivery.objects.select_related("sales_order", "customer", "warehouse", "posted_by").prefetch_related(
        "lines__product__unit", "lines__order_line")
    serializer_class = DeliverySerializer
    permission_module = "sales"
    permission_map = {"create": "sales.deliver", "update": "sales.deliver", "partial_update": "sales.deliver",
                      "destroy": "sales.deliver", "post_document": "sales.deliver", "reverse": "sales.deliver",
                      "pdf": "sales.view", "timeline": "sales.view"}
    warehouse_field = "warehouse"
    audit_entity = "delivery"
    entity_type = "delivery"
    pdf_template = "documents/delivery_note.html"
    pdf_title = "Delivery Note"
    date_field = "date"
    search_fields = ["number", "customer__name", "sales_order__number", "vehicle_number"]
    filterset_fields = {"status": ["exact", "in"], "customer": ["exact"], "sales_order": ["exact"], "warehouse": ["exact"]}
    ordering = ["-date", "-id"]

    @extend_schema(request=None)
    @action(detail=True, methods=["post"], url_path="post")
    def post_document(self, request, pk=None):
        delivery = self.get_object()
        check_warehouse_access(request, delivery.warehouse)
        return self.fresh(services.post_delivery(delivery, request.user, request=request))

    @extend_schema(request=ReasonSerializer)
    @action(detail=True, methods=["post"])
    def reverse(self, request, pk=None):
        data = ReasonSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        return self.fresh(services.reverse_delivery(self.get_object(), request.user, data.validated_data["reason"], request=request))


class SalesInvoiceViewSet(DocumentViewSet):
    queryset = SalesInvoice.objects.select_related("customer", "sales_order", "warehouse", "fiscal_year", "posted_by") \
        .prefetch_related("lines__product__unit", "lines__tax_rate")
    serializer_class = SalesInvoiceSerializer
    permission_module = "sales"
    permission_map = {"create": "sales.invoice", "update": "sales.invoice", "partial_update": "sales.invoice",
                      "destroy": "sales.invoice", "post_document": "sales.invoice", "reverse": "accounting.reverse",
                      "pdf": "sales.view", "timeline": "sales.view", "allocations": "sales.view"}
    audit_entity = "salesinvoice"
    entity_type = "salesinvoice"
    pdf_template = "documents/sales_invoice.html"
    pdf_title = "Tax Invoice"
    date_field = "invoice_date"
    search_fields = ["number", "customer__name", "customer__code", "sales_order__number", "customer_reference"]
    filterset_fields = {"status": ["exact", "in"], "payment_status": ["exact", "in"], "customer": ["exact"],
                        "sales_order": ["exact"], "fiscal_year": ["exact"], "due_date": ["lt", "lte", "gte"]}
    ordering_fields = ["invoice_date", "due_date", "number", "grand_total", "balance_due", "created_at"]
    ordering = ["-invoice_date", "-id"]

    def get_serializer_class(self):
        return SalesInvoiceListSerializer if self.action == "list" else SalesInvoiceSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request.query_params.get("overdue") == "true":
            from django.utils import timezone

            qs = qs.filter(status="POSTED", balance_due__gt=0, due_date__lt=timezone.localdate())
        if self.request.query_params.get("open") == "true":
            qs = qs.filter(status="POSTED", balance_due__gt=0)
        return qs

    def pdf_context(self, obj):
        return {"tax_breakdown": obj.tax_breakdown()}

    @extend_schema(request=None)
    @action(detail=True, methods=["post"], url_path="post")
    def post_document(self, request, pk=None):
        invoice = self.get_object()
        if invoice.warehouse_id:
            check_warehouse_access(request, invoice.warehouse)
        return self.fresh(services.post_invoice(invoice, request.user, request=request))

    @extend_schema(request=ReasonSerializer)
    @action(detail=True, methods=["post"])
    def reverse(self, request, pk=None):
        data = ReasonSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        return self.fresh(services.reverse_invoice(self.get_object(), request.user, data.validated_data["reason"], request=request))

    @action(detail=True, methods=["get"])
    def allocations(self, request, pk=None):
        invoice = self.get_object()
        rows = []
        for a in invoice.allocations.select_related("receipt", "credit_note").order_by("date", "id"):
            source = a.receipt or a.credit_note
            rows.append({"id": a.pk, "date": a.date, "amount": a.amount, "is_active": a.is_active,
                         "source_type": "receipt" if a.receipt_id else "credit_note", "source_id": source.pk,
                         "source_number": source.number, "reversed_at": a.reversed_at})
        return Response(rows)


class SalesReturnViewSet(DocumentViewSet):
    queryset = SalesReturn.objects.select_related("invoice", "customer", "warehouse").prefetch_related(
        "lines__product__unit", "lines__tax_rate", "lines__invoice_line")
    serializer_class = SalesReturnSerializer
    permission_module = "sales"
    permission_map = {"create": "sales.return", "update": "sales.return", "partial_update": "sales.return",
                      "destroy": "sales.return", "post_document": "sales.return", "apply": "sales.receipt",
                      "pdf": "sales.view", "timeline": "sales.view"}
    audit_entity = "salesreturn"
    entity_type = "salesreturn"
    pdf_template = "documents/credit_note.html"
    pdf_title = "Credit Note"
    date_field = "date"
    search_fields = ["number", "customer__name", "invoice__number", "reason"]
    filterset_fields = {"status": ["exact"], "customer": ["exact"], "invoice": ["exact"]}
    ordering = ["-date", "-id"]

    def pdf_context(self, obj):
        return {"tax_breakdown": obj.tax_breakdown()}

    @extend_schema(request=None)
    @action(detail=True, methods=["post"], url_path="post")
    def post_document(self, request, pk=None):
        return self.fresh(services.post_sales_return(self.get_object(), request.user, request=request))

    @extend_schema(request=AllocationItemSerializer(many=True))
    @action(detail=True, methods=["post"])
    def apply(self, request, pk=None):
        from apps.payments.services import allocate_credit_note

        items = AllocationItemSerializer(data=request.data.get("allocations", []), many=True)
        items.is_valid(raise_exception=True)
        allocate_credit_note(self.get_object(), [(i["document"], i["amount"]) for i in items.validated_data], request.user,
                             request=request)
        return self.fresh(self.get_object())
