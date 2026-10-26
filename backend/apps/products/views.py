from decimal import Decimal

from django.db import transaction
from django.db.models import Count, DecimalField, OuterRef, Subquery, Sum, Value
from django.db.models.functions import Coalesce
from drf_spectacular.utils import extend_schema
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response

from apps.audit.services import record_event
from apps.core.export import export_response
from apps.core.money import rate
from apps.core.viewsets import OrganizationModelViewSet
from apps.inventory.models import StockBalance

from .importer import COLUMNS, import_products
from .models import Brand, Product, ProductCategory
from .serializers import BrandSerializer, BulkPriceUpdateSerializer, ProductCategorySerializer, ProductSerializer


def _stock_sum(field, warehouse_ids=None):
    qs = StockBalance.objects.filter(product=OuterRef("pk"), warehouse__is_transit=False)
    if warehouse_ids:
        qs = qs.filter(warehouse_id__in=warehouse_ids)
    sub = qs.values("product").annotate(total=Sum(field)).values("total")
    out = DecimalField(max_digits=18, decimal_places=3)
    return Coalesce(Subquery(sub, output_field=out), Value(Decimal("0")), output_field=out)


class ProductCategoryViewSet(OrganizationModelViewSet):
    queryset = ProductCategory.objects.annotate(product_count=Count("products"))
    serializer_class = ProductCategorySerializer
    permission_module = "products"
    permission_map = {"list": None, "retrieve": None}
    audit_entity = "product_category"
    pagination_class = None
    search_fields = ["name"]

    def perform_create(self, serializer):
        serializer.save(organization=self.request.organization)


class BrandViewSet(ProductCategoryViewSet):
    queryset = Brand.objects.all()
    serializer_class = BrandSerializer
    audit_entity = "brand"


class ProductViewSet(OrganizationModelViewSet):
    queryset = Product.objects.select_related("category", "brand", "unit", "tax_rate").prefetch_related("price_tiers")
    serializer_class = ProductSerializer
    permission_module = "products"
    permission_map = {"bulk_price_update": "products.price_update", "import_products": "products.manage",
                      "export": "products.view", "lookup": "products.view", "stock": ("products.view", "inventory.view"),
                      "history": "inventory.view", "price": "products.view", "import_template": "products.view"}
    audit_entity = "product"
    parser_classes = [JSONParser, MultiPartParser, FormParser]
    search_fields = ["sku", "name", "barcode", "description"]
    filterset_fields = {"is_active": ["exact"], "category": ["exact"], "brand": ["exact"], "product_type": ["exact"],
                        "track_batches": ["exact"], "track_serials": ["exact"]}
    ordering_fields = ["sku", "name", "selling_price", "purchase_price", "on_hand", "stock_value", "reorder_level", "created_at"]
    ordering = ["name"]

    def get_queryset(self):
        warehouse = self.request.query_params.get("warehouse")
        ids = [int(warehouse)] if warehouse and warehouse.isdigit() else None
        qs = super().get_queryset().annotate(
            on_hand=_stock_sum("on_hand", ids), reserved=_stock_sum("reserved", ids), stock_value=_stock_sum("value", ids)
        )
        if self.request.query_params.get("low_stock") == "true":
            from django.db.models import F

            qs = qs.filter(product_type="STOCK", reorder_level__gt=0, on_hand__lte=F("reorder_level"))
        return qs

    @action(detail=False, methods=["get"])
    def lookup(self, request):
        """Exact barcode or SKU lookup for scanners."""
        code = (request.query_params.get("code") or "").strip()
        product = self.get_queryset().filter(barcode=code).first() or self.get_queryset().filter(sku=code.upper()).first()
        if product is None:
            raise NotFound("No product with that barcode or SKU.")
        return Response(self.get_serializer(product).data)

    @action(detail=True, methods=["get"])
    def price(self, request, pk=None):
        """Applicable unit price for a customer and quantity (wholesale tiers)."""
        from apps.customers.models import Customer
        from apps.sales.services import price_for

        product = self.get_object()
        customer = Customer.objects.filter(organization=request.organization, pk=request.query_params.get("customer") or 0).first()
        quantity = Decimal(request.query_params.get("quantity") or "1")
        return Response({"unit_price": price_for(product, customer, quantity)})

    @action(detail=True, methods=["get"])
    def stock(self, request, pk=None):
        from apps.inventory.models import CostLayer

        product = self.get_object()
        balances = StockBalance.objects.filter(product=product).select_related("warehouse").order_by("warehouse__code")
        batches = (CostLayer.objects.filter(product=product, remaining_quantity__gt=0, batch__isnull=False)
                   .values("warehouse__code", "batch__batch_number", "batch__expiry_date")
                   .annotate(quantity=Sum("remaining_quantity")).order_by("batch__expiry_date"))
        return Response({
            "warehouses": [{"warehouse_id": b.warehouse_id, "warehouse": str(b.warehouse), "is_transit": b.warehouse.is_transit,
                            "on_hand": b.on_hand, "reserved": b.reserved, "available": b.available, "value": b.value,
                            "unit_cost": rate(b.value / b.on_hand) if b.on_hand else b.last_unit_cost} for b in balances],
            "batches": [{"warehouse": r["warehouse__code"], "batch": r["batch__batch_number"],
                         "expiry_date": r["batch__expiry_date"], "quantity": r["quantity"]} for r in batches],
        })

    @action(detail=True, methods=["get"])
    def history(self, request, pk=None):
        from apps.inventory.serializers import LedgerEntrySerializer
        from apps.inventory.views import ledger_queryset

        product = self.get_object()
        qs = ledger_queryset(request).filter(product=product).order_by("-date", "-id")
        page = self.paginate_queryset(qs)
        return self.get_paginated_response(LedgerEntrySerializer(page, many=True).data)

    @extend_schema(request=BulkPriceUpdateSerializer)
    @action(detail=False, methods=["post"], url_path="bulk-price-update")
    def bulk_price_update(self, request):
        data = BulkPriceUpdateSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        params = data.validated_data
        qs = Product.objects.filter(organization=request.organization)
        if params.get("product_ids"):
            qs = qs.filter(pk__in=params["product_ids"])
        elif params.get("category"):
            qs = qs.filter(category_id=params["category"])
        else:
            raise serializers.ValidationError({"product_ids": ["Choose products or a category."]})
        field, mode, value = params["field"], params["mode"], params["value"]
        changes = []
        with transaction.atomic():
            for product in qs.select_for_update():
                old = getattr(product, field)
                if mode == "percent":
                    new = old * (1 + value / 100)
                elif mode == "amount":
                    new = old + value
                else:
                    new = value
                new = rate(max(new, Decimal("0")))
                if new != old:
                    setattr(product, field, new)
                    product.save(update_fields=[field, "updated_at"])
                    changes.append({"id": product.pk, "sku": product.sku, "old": str(old), "new": str(new)})
            record_event(request, "product.bulk_price_update", "product", entity_id="bulk", reason=params["reason"],
                         new={"field": field, "mode": mode, "value": str(value), "changes": changes[:500]})
        return Response({"updated": len(changes), "changes": changes})

    @action(detail=False, methods=["post"], url_path="import")
    def import_products(self, request):
        upload = request.FILES.get("file")
        if upload is None:
            raise serializers.ValidationError({"file": ["Choose a CSV or Excel file."]})
        if upload.size > 5 * 1024 * 1024:
            raise serializers.ValidationError({"file": ["The file must be smaller than 5 MB."]})
        result = import_products(request.organization, request.user, upload,
                                 update_existing=request.data.get("update_existing") in ("true", "1", True),
                                 dry_run=request.data.get("dry_run") in ("true", "1", True))
        if not result["errors"] and not result["dry_run"]:
            record_event(request, "product.imported", "product", entity_id="import",
                         new={"created": result["created"], "updated": result["updated"], "file": upload.name})
        return Response(result, status=400 if result["errors"] else 200)

    @action(detail=False, methods=["get"], url_path="import-template")
    def import_template(self, request):
        sample = [{"sku": "ITM-SAMPLE", "name": "Sample product", "barcode": "", "product_type": "STOCK", "category": "General",
                   "brand": "", "unit": "PCS", "purchase_price": "100", "selling_price": "125", "tax_rate": "13",
                   "reorder_level": "10", "description": ""}]
        return export_response(sample, [(c, c, "text") for c in COLUMNS], "product-import-template",
                               request.query_params.get("export", "csv"))

    @action(detail=False, methods=["get"])
    def export(self, request):
        rows = self.filter_queryset(self.get_queryset())
        columns = [("sku", "SKU", "text"), ("barcode", "Barcode", "text"), ("name", "Name", "text"),
                   ("product_type", "Type", "text"), ("category.name", "Category", "text"), ("brand.name", "Brand", "text"),
                   ("unit.code", "Unit", "text"), ("purchase_price", "Purchase price", "money"),
                   ("selling_price", "Selling price", "money"), ("tax_rate.rate", "Tax %", "number"),
                   ("reorder_level", "Reorder level", "qty"), ("on_hand", "On hand", "qty"), ("reserved", "Reserved", "qty"),
                   ("stock_value", "Stock value", "money"), ("is_active", "Active", "text")]
        return export_response(rows, columns, "products", request.query_params.get("export", "csv"))
