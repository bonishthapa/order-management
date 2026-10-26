from django.db import transaction
from drf_spectacular.utils import extend_schema
from rest_framework import mixins, serializers, status
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.core.document_views import DocumentViewSet
from apps.core.serializers import AllocationItemSerializer, ReasonSerializer

from . import services
from .models import CustomerReceipt, CustomerRefund, PaymentVoucher, SupplierRefund
from .serializers import (
    CustomerReceiptSerializer,
    CustomerRefundSerializer,
    PaymentVoucherSerializer,
    SupplierRefundSerializer,
)


class AllocateSerializer(serializers.Serializer):
    allocations = AllocationItemSerializer(many=True)


class CustomerReceiptViewSet(DocumentViewSet):
    """Receipts are posted as soon as they are recorded; corrections are reversals."""

    http_method_names = ["get", "post", "head", "options"]
    queryset = CustomerReceipt.objects.select_related("customer", "payment_method", "deposit_account", "received_by",
                                                      "journal").prefetch_related("allocations__invoice")
    serializer_class = CustomerReceiptSerializer
    permission_module = "sales"
    permission_map = {"create": "sales.receipt", "allocate": "sales.receipt", "reverse": "accounting.reverse",
                      "pdf": "sales.view", "timeline": "sales.view"}
    audit_entity = None
    entity_type = "customerreceipt"
    pdf_template = "documents/receipt.html"
    pdf_title = "Payment Receipt"
    date_field = "date"
    search_fields = ["number", "customer__name", "reference"]
    filterset_fields = {"status": ["exact"], "customer": ["exact"], "payment_method": ["exact"], "deposit_account": ["exact"]}
    ordering_fields = ["date", "number", "amount", "created_at"]
    ordering = ["-date", "-id"]

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request.query_params.get("unapplied") == "true":
            from django.db.models import F

            qs = qs.filter(status="POSTED", amount__gt=F("allocated_amount") + F("refunded_amount"))
        return qs

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        receipt = services.create_receipt(
            request.organization, request.user, customer=data["customer"], date=data["date"], amount=data["amount"],
            payment_method=data["payment_method"], deposit_account=data["deposit_account"],
            reference=data.get("reference", ""), notes=data.get("notes", ""),
            allocations=[(a["document"], a["amount"]) for a in data.get("allocate", []) if a["amount"] > 0], request=request,
        )
        return Response(self.get_serializer(self.get_queryset().get(pk=receipt.pk)).data, status=status.HTTP_201_CREATED)

    @extend_schema(request=AllocateSerializer)
    @action(detail=True, methods=["post"])
    def allocate(self, request, pk=None):
        data = AllocateSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        services.allocate_receipt(self.get_object(), [(a["document"], a["amount"]) for a in data.validated_data["allocations"]],
                                  request.user, request=request)
        return self.fresh(self.get_object())

    @extend_schema(request=ReasonSerializer)
    @action(detail=True, methods=["post"])
    def reverse(self, request, pk=None):
        data = ReasonSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        return self.fresh(services.reverse_receipt(self.get_object(), request.user, data.validated_data["reason"], request=request))


class CustomerRefundViewSet(DocumentViewSet):
    http_method_names = ["get", "post", "head", "options"]
    queryset = CustomerRefund.objects.select_related("customer", "receipt", "credit_note", "payment_method")
    serializer_class = CustomerRefundSerializer
    permission_module = "sales"
    permission_map = {"create": "sales.receipt", "pdf": "sales.view", "timeline": "sales.view"}
    entity_type = "customerrefund"
    pdf_template = "documents/refund.html"
    pdf_title = "Refund Voucher"
    date_field = "date"
    search_fields = ["number", "customer__name", "reference"]
    filterset_fields = ["customer", "status"]
    ordering = ["-date", "-id"]

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        d = serializer.validated_data
        refund = services.create_customer_refund(
            request.organization, request.user, customer=d["customer"], date=d["date"], amount=d["amount"],
            payment_method=d["payment_method"], paid_from_account=d["paid_from_account"], receipt=d.get("receipt"),
            credit_note=d.get("credit_note"), reference=d.get("reference", ""), notes=d.get("notes", ""), request=request,
        )
        return Response(self.get_serializer(refund).data, status=status.HTTP_201_CREATED)


class PaymentVoucherViewSet(DocumentViewSet):
    queryset = PaymentVoucher.objects.select_related("supplier", "payment_method", "paid_from_account", "prepared_by",
                                                     "approved_by", "journal").prefetch_related("allocations__bill")
    serializer_class = PaymentVoucherSerializer
    permission_module = "purchases"
    permission_map = {"create": "purchases.payment", "update": "purchases.payment", "partial_update": "purchases.payment",
                      "destroy": "purchases.payment", "post_document": ("purchases.payment", "accounting.post"),
                      "allocate": "purchases.payment", "reverse": "accounting.reverse", "pdf": "purchases.view",
                      "timeline": "purchases.view"}
    audit_entity = "paymentvoucher"
    entity_type = "paymentvoucher"
    pdf_template = "documents/payment_voucher.html"
    pdf_title = "Payment Voucher"
    date_field = "date"
    search_fields = ["number", "supplier__name", "reference"]
    filterset_fields = {"status": ["exact"], "supplier": ["exact"], "payment_method": ["exact"], "paid_from_account": ["exact"]}
    ordering_fields = ["date", "number", "amount", "created_at"]
    ordering = ["-date", "-id"]

    def perform_create(self, serializer):
        with transaction.atomic():
            voucher = serializer.save(organization=self.request.organization, created_by=self.request.user,
                                      prepared_by=self.request.user)
            from apps.audit.services import record_event, snapshot

            record_event(self.request, "created", "paymentvoucher", voucher, new=snapshot(voucher))

    def perform_update(self, serializer):
        if serializer.instance.status != "DRAFT":
            from apps.core.exceptions import BusinessRuleError

            raise BusinessRuleError("Posted vouchers cannot be edited; reverse them instead.", "not_editable")
        super().perform_update(serializer)

    @extend_schema(request=None)
    @action(detail=True, methods=["post"], url_path="post")
    def post_document(self, request, pk=None):
        return self.fresh(services.post_voucher(self.get_object(), request.user, request=request))

    @extend_schema(request=AllocateSerializer)
    @action(detail=True, methods=["post"])
    def allocate(self, request, pk=None):
        data = AllocateSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        services.allocate_voucher(self.get_object(), [(a["document"], a["amount"]) for a in data.validated_data["allocations"]],
                                  request.user, request=request)
        return self.fresh(self.get_object())

    @extend_schema(request=ReasonSerializer)
    @action(detail=True, methods=["post"])
    def reverse(self, request, pk=None):
        data = ReasonSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        return self.fresh(services.reverse_voucher(self.get_object(), request.user, data.validated_data["reason"], request=request))


class SupplierRefundViewSet(DocumentViewSet):
    http_method_names = ["get", "post", "head", "options"]
    queryset = SupplierRefund.objects.select_related("supplier", "voucher", "debit_note", "payment_method")
    serializer_class = SupplierRefundSerializer
    permission_module = "purchases"
    permission_map = {"create": "purchases.payment", "pdf": "purchases.view", "timeline": "purchases.view"}
    entity_type = "supplierrefund"
    pdf_template = "documents/refund.html"
    pdf_title = "Supplier Refund Receipt"
    date_field = "date"
    search_fields = ["number", "supplier__name", "reference"]
    filterset_fields = ["supplier", "status"]
    ordering = ["-date", "-id"]

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        d = serializer.validated_data
        refund = services.create_supplier_refund(
            request.organization, request.user, supplier=d["supplier"], date=d["date"], amount=d["amount"],
            payment_method=d["payment_method"], deposit_account=d["deposit_account"], voucher=d.get("voucher"),
            debit_note=d.get("debit_note"), reference=d.get("reference", ""), notes=d.get("notes", ""), request=request,
        )
        return Response(self.get_serializer(refund).data, status=status.HTTP_201_CREATED)
