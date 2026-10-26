from django.db import transaction
from django.db.models import Count, F, Q, Sum
from drf_spectacular.utils import extend_schema
from rest_framework import mixins, serializers, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.calendar_utils.fields import parse_date_input
from apps.core.export import export_response
from apps.core.permissions import HasModulePermission, allowed_warehouse_ids, check_warehouse_access
from apps.core.serializers import ReasonSerializer
from apps.core.viewsets import OrganizationModelViewSet, OrganizationReadOnlyViewSet

from . import services
from .models import (
    Batch,
    CostLayer,
    SerialNumber,
    StockBalance,
    StockCount,
    StockLedgerEntry,
    StockMovement,
    StockReservation,
    StockTransfer,
    Warehouse,
)
from .serializers import (
    BatchSerializer,
    LedgerEntrySerializer,
    ReservationSerializer,
    SerialSerializer,
    StockBalanceSerializer,
    StockCountSerializer,
    StockMovementSerializer,
    StockTransferSerializer,
    WarehouseSerializer,
)


def ledger_queryset(request):
    qs = StockLedgerEntry.objects.filter(organization=request.organization).select_related(
        "product", "warehouse", "movement", "batch", "created_by")
    ids = allowed_warehouse_ids(request)
    if ids is not None:
        qs = qs.filter(warehouse_id__in=ids)
    return qs


class WarehouseViewSet(OrganizationModelViewSet):
    queryset = Warehouse.objects.prefetch_related("locations").select_related("branch")
    serializer_class = WarehouseSerializer
    permission_module = "inventory"
    permission_map = {"list": None, "retrieve": None, "create": "settings.manage", "update": "settings.manage",
                      "partial_update": "settings.manage", "destroy": "settings.manage"}
    audit_entity = "warehouse"
    pagination_class = None
    filterset_fields = ["is_active", "is_transit", "branch"]

    def get_queryset(self):
        qs = super().get_queryset().annotate(
            stock_value=Sum("balances__value"), product_count=Count("balances", filter=Q(balances__on_hand__gt=0)))
        if self.request.query_params.get("include_transit") != "true":
            qs = qs.filter(is_transit=False)
        return qs

    def perform_create(self, serializer):
        with transaction.atomic():
            serializer.save(organization=self.request.organization)


class StockBalanceViewSet(mixins.ListModelMixin, viewsets.GenericViewSet):
    """Stock on hand right now, per product and warehouse."""

    serializer_class = StockBalanceSerializer
    permission_classes = [HasModulePermission]
    permission_module = "inventory"
    search_fields = ["product__sku", "product__name", "product__barcode"]
    filterset_fields = {"warehouse": ["exact"], "product": ["exact"], "product__category": ["exact"]}
    ordering_fields = ["product__sku", "product__name", "on_hand", "reserved", "value", "warehouse__code"]
    ordering = ["product__name", "warehouse__code"]

    def get_queryset(self):
        qs = (StockBalance.objects.filter(organization=self.request.organization)
              .select_related("product", "product__unit", "product__category", "warehouse"))
        ids = allowed_warehouse_ids(self.request)
        if ids is not None:
            qs = qs.filter(warehouse_id__in=ids)
        params = self.request.query_params
        if params.get("include_zero") != "true":
            qs = qs.exclude(on_hand=0, reserved=0)
        if params.get("low_stock") == "true":
            qs = qs.filter(product__reorder_level__gt=0, on_hand__lte=F("product__reorder_level"))
        if params.get("include_transit") != "true":
            qs = qs.filter(warehouse__is_transit=False)
        return qs

    @action(detail=False, methods=["get"])
    def export(self, request):
        columns = [("product.sku", "SKU", "text"), ("product.name", "Product", "text"), ("warehouse.code", "Warehouse", "text"),
                   ("on_hand", "On hand", "qty"), ("reserved", "Reserved", "qty"), ("available", "Available", "qty"),
                   ("value", "Value", "money")]
        return export_response(self.filter_queryset(self.get_queryset()), columns, "stock-on-hand",
                               request.query_params.get("export", "csv"))


class StockLedgerViewSet(mixins.ListModelMixin, viewsets.GenericViewSet):
    """Posted stock movements (immutable history)."""

    serializer_class = LedgerEntrySerializer
    permission_classes = [HasModulePermission]
    permission_module = "inventory"
    date_field = "date"
    search_fields = ["product__sku", "product__name", "reference_number", "movement__number"]
    filterset_fields = {"warehouse": ["exact"], "product": ["exact"], "movement_type": ["exact", "in"],
                        "reference_type": ["exact"], "movement": ["exact"]}
    ordering_fields = ["date", "id", "quantity", "value"]
    ordering = ["-date", "-id"]

    def get_queryset(self):
        return ledger_queryset(self.request)

    @action(detail=False, methods=["get"])
    def export(self, request):
        columns = [("date", "Date", "date"), ("movement.number", "Movement", "text"), ("movement_type", "Type", "text"),
                   ("product.sku", "SKU", "text"), ("product.name", "Product", "text"), ("warehouse.code", "Warehouse", "text"),
                   ("quantity", "Quantity", "qty"), ("unit_cost", "Unit cost", "money"), ("value", "Value", "money"),
                   ("balance_quantity", "Balance qty", "qty"), ("reference_number", "Reference", "text")]
        return export_response(self.filter_queryset(self.get_queryset()), columns, "stock-movements",
                               request.query_params.get("export", "csv"))


class StockMovementViewSet(OrganizationModelViewSet):
    queryset = StockMovement.objects.select_related("warehouse", "posted_by", "created_by", "journal").prefetch_related(
        "lines__product")
    serializer_class = StockMovementSerializer
    permission_module = "inventory"
    permission_map = {"post_document": "inventory.post", "reverse": ("inventory.post", "accounting.reverse")}
    warehouse_field = "warehouse"
    audit_entity = "stock_movement"
    date_field = "date"
    search_fields = ["number", "reason", "reference_number"]
    filterset_fields = {"status": ["exact"], "movement_type": ["exact", "in"], "warehouse": ["exact"]}
    ordering_fields = ["date", "number", "created_at"]
    ordering = ["-date", "-id"]

    def perform_create(self, serializer):
        check_warehouse_access(self.request, serializer.validated_data.get("warehouse"))
        super().perform_create(serializer)

    @extend_schema(request=None)
    @action(detail=True, methods=["post"], url_path="post")
    def post_document(self, request, pk=None):
        movement = services.post_manual_movement(self.get_object(), request.user, request=request)
        return Response(self.get_serializer(self.get_queryset().get(pk=movement.pk)).data)

    @extend_schema(request=ReasonSerializer)
    @action(detail=True, methods=["post"])
    def reverse(self, request, pk=None):
        data = ReasonSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        reversal = services.reverse_movement(self.get_object(), request.user, data.validated_data["reason"], request=request)
        return Response(self.get_serializer(self.get_queryset().get(pk=reversal.pk)).data)


class StockTransferViewSet(OrganizationModelViewSet):
    queryset = StockTransfer.objects.select_related("source_warehouse", "destination_warehouse", "dispatched_by",
                                                    "received_by").prefetch_related("lines__product")
    serializer_class = StockTransferSerializer
    permission_module = "inventory"
    permission_map = {"dispatch_transfer": "inventory.post", "receive": "inventory.post", "cancel": "inventory.manage"}
    audit_entity = "stock_transfer"
    date_field = "date"
    search_fields = ["number", "notes"]
    filterset_fields = ["status", "source_warehouse", "destination_warehouse"]
    ordering = ["-date", "-id"]

    def get_queryset(self):
        qs = super().get_queryset()
        ids = allowed_warehouse_ids(self.request)
        if ids is not None:
            qs = qs.filter(Q(source_warehouse_id__in=ids) | Q(destination_warehouse_id__in=ids))
        return qs

    def perform_create(self, serializer):
        check_warehouse_access(self.request, serializer.validated_data.get("source_warehouse"))
        super().perform_create(serializer)

    @extend_schema(request=None)
    @action(detail=True, methods=["post"], url_path="dispatch")
    def dispatch_transfer(self, request, pk=None):
        transfer = self.get_object()
        check_warehouse_access(request, transfer.source_warehouse)
        services.dispatch_transfer(transfer, request.user, request=request)
        return Response(self.get_serializer(self.get_queryset().get(pk=transfer.pk)).data)

    @extend_schema(request=None)
    @action(detail=True, methods=["post"])
    def receive(self, request, pk=None):
        transfer = self.get_object()
        check_warehouse_access(request, transfer.destination_warehouse)
        date = parse_date_input(request.data.get("date"), request.data.get("date_bs"), "date")
        services.receive_transfer(transfer, request.user, date=date, request=request)
        return Response(self.get_serializer(self.get_queryset().get(pk=transfer.pk)).data)

    @extend_schema(request=None)
    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        transfer = self.get_object()
        if transfer.status != "DRAFT":
            raise serializers.ValidationError("Only draft transfers can be cancelled.")
        transfer.status = "CANCELLED"
        transfer.save(update_fields=["status", "updated_at"])
        from apps.audit.services import record_event

        record_event(request, "transfer.cancelled", "stock_transfer", transfer)
        return Response(self.get_serializer(transfer).data)


class StockCountViewSet(OrganizationModelViewSet):
    queryset = StockCount.objects.select_related("warehouse", "posted_by").prefetch_related("lines__product__unit")
    serializer_class = StockCountSerializer
    permission_module = "inventory"
    permission_map = {"post_document": "inventory.post", "populate": "inventory.manage", "cancel": "inventory.manage"}
    warehouse_field = "warehouse"
    audit_entity = "stock_count"
    date_field = "date"
    search_fields = ["number", "notes"]
    filterset_fields = ["status", "warehouse"]
    ordering = ["-date", "-id"]

    @extend_schema(request=None)
    @action(detail=True, methods=["post"])
    def populate(self, request, pk=None):
        """Add every product with stock (or matching a category) in the count's warehouse."""
        from .models import StockCountLine

        count = self.get_object()
        if count.status != "DRAFT":
            raise serializers.ValidationError("Posted counts cannot be changed.")
        balances = StockBalance.objects.filter(warehouse=count.warehouse).exclude(on_hand=0).select_related("product")
        if request.data.get("category"):
            balances = balances.filter(product__category_id=request.data["category"])
        existing = set(count.lines.values_list("product_id", flat=True))
        StockCountLine.objects.bulk_create(
            StockCountLine(count=count, product=b.product, system_quantity=b.on_hand)
            for b in balances if b.product_id not in existing
        )
        return Response(self.get_serializer(self.get_queryset().get(pk=count.pk)).data)

    @extend_schema(request=None)
    @action(detail=True, methods=["post"], url_path="post")
    def post_document(self, request, pk=None):
        count = services.post_count(self.get_object(), request.user, request=request)
        return Response(self.get_serializer(self.get_queryset().get(pk=count.pk)).data)

    @extend_schema(request=None)
    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        count = self.get_object()
        if count.status != "DRAFT":
            raise serializers.ValidationError("Only counts in progress can be cancelled.")
        count.status = "CANCELLED"
        count.save(update_fields=["status", "updated_at"])
        return Response(self.get_serializer(count).data)


class BatchViewSet(OrganizationReadOnlyViewSet):
    queryset = Batch.objects.select_related("product")
    serializer_class = BatchSerializer
    permission_module = "inventory"
    search_fields = ["batch_number", "product__sku", "product__name"]
    filterset_fields = {"product": ["exact"], "expiry_date": ["lte", "gte"]}
    ordering = ["expiry_date", "batch_number"]

    def get_queryset(self):
        qs = super().get_queryset().annotate(quantity=Sum("layers__remaining_quantity"))
        if self.request.query_params.get("in_stock") == "true":
            qs = qs.filter(quantity__gt=0)
        warehouse = self.request.query_params.get("warehouse")
        if warehouse:
            qs = qs.filter(layers__warehouse_id=warehouse, layers__remaining_quantity__gt=0).distinct()
        return qs


class SerialViewSet(OrganizationReadOnlyViewSet):
    queryset = SerialNumber.objects.select_related("product", "warehouse")
    serializer_class = SerialSerializer
    permission_module = "inventory"
    search_fields = ["serial", "product__sku"]
    filterset_fields = ["product", "warehouse", "status"]
    ordering = ["serial"]


class ReservationViewSet(OrganizationReadOnlyViewSet):
    queryset = StockReservation.objects.select_related("product", "warehouse", "sales_order_line__order__customer")
    serializer_class = ReservationSerializer
    permission_module = "inventory"
    warehouse_field = "warehouse"
    filterset_fields = ["product", "warehouse", "status"]
    ordering = ["-created_at"]
