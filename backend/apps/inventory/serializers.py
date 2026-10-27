from rest_framework import serializers

from apps.core.serializers import BaseModelSerializer, DocumentSerializer, OrgRelatedField
from apps.organizations.models import Branch
from apps.products.models import Product

from .models import (
    MANUAL_MOVEMENT_TYPES,
    Batch,
    SerialNumber,
    StockBalance,
    StockCount,
    StockCountLine,
    StockLedgerEntry,
    StockMovement,
    StockMovementLine,
    StockReservation,
    StockTransfer,
    StockTransferLine,
    StorageLocation,
    Warehouse,
)


class StorageLocationSerializer(serializers.ModelSerializer):
    id = serializers.IntegerField(required=False)

    class Meta:
        model = StorageLocation
        fields = ["id", "code", "name", "is_active"]


class WarehouseSerializer(BaseModelSerializer):
    branch = OrgRelatedField(Branch, required=False, allow_null=True)
    branch_name = serializers.CharField(source="branch.name", read_only=True, default=None)
    locations = StorageLocationSerializer(many=True, required=False)
    stock_value = serializers.DecimalField(max_digits=18, decimal_places=2, read_only=True, default=None)
    product_count = serializers.IntegerField(read_only=True, default=None)

    class Meta:
        model = Warehouse
        fields = ["id", "code", "name", "branch", "branch_name", "address", "is_transit", "is_active", "locations",
                  "stock_value", "product_count"]
        read_only_fields = ["is_transit"]

    def validate_code(self, value):
        value = value.strip().upper()
        qs = Warehouse.objects.filter(organization=self.organization, code=value)
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError("Another warehouse uses this code.")
        return value

    def _save_locations(self, warehouse, locations):
        if locations is None:
            return
        keep = []
        for data in locations:
            loc_id = data.pop("id", None)
            loc = warehouse.locations.filter(pk=loc_id).first() if loc_id else None
            if loc:
                for k, v in data.items():
                    setattr(loc, k, v)
                loc.save()
            else:
                loc = StorageLocation.objects.create(warehouse=warehouse, **data)
            keep.append(loc.pk)
        warehouse.locations.exclude(pk__in=keep).update(is_active=False)

    def create(self, validated_data):
        locations = validated_data.pop("locations", None)
        warehouse = Warehouse.objects.create(**validated_data)
        self._save_locations(warehouse, locations)
        return warehouse

    def update(self, instance, validated_data):
        locations = validated_data.pop("locations", None)
        instance = super().update(instance, validated_data)
        self._save_locations(instance, locations)
        return instance


class StockBalanceSerializer(serializers.ModelSerializer):
    sku = serializers.CharField(source="product.sku")
    product_name = serializers.CharField(source="product.name")
    unit = serializers.CharField(source="product.unit.code")
    category = serializers.CharField(source="product.category.name", default=None)
    warehouse_code = serializers.CharField(source="warehouse.code")
    warehouse_name = serializers.CharField(source="warehouse.name")
    reorder_level = serializers.DecimalField(source="product.reorder_level", max_digits=16, decimal_places=3)
    available = serializers.DecimalField(max_digits=16, decimal_places=3, read_only=True)
    unit_cost = serializers.SerializerMethodField()

    class Meta:
        model = StockBalance
        fields = ["id", "product", "sku", "product_name", "unit", "category", "warehouse", "warehouse_code", "warehouse_name",
                  "on_hand", "reserved", "available", "value", "unit_cost", "reorder_level", "updated_at"]

    def get_unit_cost(self, obj):
        from apps.core.money import rate

        return str(rate(obj.value / obj.on_hand)) if obj.on_hand else str(obj.last_unit_cost)


class LedgerEntrySerializer(BaseModelSerializer):
    sku = serializers.CharField(source="product.sku")
    product_name = serializers.CharField(source="product.name")
    warehouse_code = serializers.CharField(source="warehouse.code")
    movement_number = serializers.CharField(source="movement.number")
    movement_type_label = serializers.CharField(source="get_movement_type_display")
    batch_number = serializers.CharField(source="batch.batch_number", default=None)
    created_by_name = serializers.CharField(source="created_by.full_name", default=None)

    class Meta:
        model = StockLedgerEntry
        fields = ["id", "date", "movement", "movement_number", "movement_type", "movement_type_label", "product", "sku",
                  "product_name", "warehouse", "warehouse_code", "batch_number", "quantity", "unit_cost", "value",
                  "balance_quantity", "balance_value", "reference_type", "reference_id", "reference_number",
                  "serial_numbers", "created_by_name", "posted_at"]


class MovementLineSerializer(serializers.ModelSerializer):
    product = OrgRelatedField(Product)
    sku = serializers.CharField(source="product.sku", read_only=True)
    product_name = serializers.CharField(source="product.name", read_only=True)
    location = serializers.PrimaryKeyRelatedField(queryset=StorageLocation.objects.all(), required=False, allow_null=True)

    class Meta:
        model = StockMovementLine
        fields = ["id", "product", "sku", "product_name", "location", "quantity", "unit_cost", "batch_number", "expiry_date",
                  "serial_numbers", "notes"]

    def validate_location(self, value):
        organization = self.context.get("organization")
        if value and value.warehouse.organization_id != getattr(organization, "id", None):
            raise serializers.ValidationError("Unknown location.")
        return value


class StockMovementSerializer(DocumentSerializer):
    warehouse = OrgRelatedField(Warehouse, extra_filter={"is_transit": False})
    warehouse_name = serializers.CharField(source="warehouse.__str__", read_only=True)
    lines = MovementLineSerializer(many=True)
    line_serializer_class = MovementLineSerializer
    line_fk = "movement"
    movement_type_label = serializers.CharField(source="get_movement_type_display", read_only=True)
    posted_by_name = serializers.CharField(source="posted_by.full_name", read_only=True, default=None)
    created_by_name = serializers.CharField(source="created_by.full_name", read_only=True, default=None)
    journal_number = serializers.CharField(source="journal.number", read_only=True, default=None)
    total_value = serializers.SerializerMethodField()
    reversal_of_number = serializers.CharField(source="reversal_of.number", read_only=True, default=None)
    reversed_by = serializers.SerializerMethodField()

    class Meta:
        model = StockMovement
        fields = ["id", "number", "movement_type", "movement_type_label", "date", "warehouse", "warehouse_name", "reason",
                  "reference_type", "reference_id", "reference_number", "status", "posted_by_name", "posted_at",
                  "created_by_name", "journal", "journal_number", "reversal_of", "reversal_of_number", "reversed_by", "notes",
                  "lines", "total_value", "created_at"]
        read_only_fields = ["number", "reference_type", "reference_id", "reference_number", "status", "posted_at",
                            "journal", "reversal_of"]

    def get_reversed_by(self, obj):
        reversal = StockMovement.objects.filter(reversal_of=obj).only("id", "number").first()
        return {"id": reversal.pk, "number": reversal.number} if reversal else None

    def get_total_value(self, obj):
        from django.db.models import Sum

        return obj.ledger_entries.aggregate(v=Sum("value"))["v"]

    def validate_movement_type(self, value):
        if value not in MANUAL_MOVEMENT_TYPES:
            raise serializers.ValidationError("Only opening stock, adjustments and write-offs are entered manually.")
        return value

    def validate(self, attrs):
        attrs = super().validate(attrs)
        if not attrs.get("reason") and not getattr(self.instance, "reason", ""):
            raise serializers.ValidationError({"reason": ["Give a reason for the movement."]})
        for line in attrs.get("lines", []):
            if line["quantity"] == 0:
                raise serializers.ValidationError({"lines": ["Quantities cannot be zero."]})
            if not line["product"].is_stock:
                raise serializers.ValidationError({"lines": [f"{line['product'].sku} is a non-stock item."]})
        return attrs


class TransferLineSerializer(serializers.ModelSerializer):
    product = OrgRelatedField(Product, extra_filter={"product_type": "STOCK"})
    sku = serializers.CharField(source="product.sku", read_only=True)
    product_name = serializers.CharField(source="product.name", read_only=True)

    class Meta:
        model = StockTransferLine
        fields = ["id", "product", "sku", "product_name", "quantity", "batch_number", "serial_numbers"]


class StockTransferSerializer(DocumentSerializer):
    source_warehouse = OrgRelatedField(Warehouse, extra_filter={"is_transit": False})
    destination_warehouse = OrgRelatedField(Warehouse, extra_filter={"is_transit": False})
    source_name = serializers.CharField(source="source_warehouse.__str__", read_only=True)
    destination_name = serializers.CharField(source="destination_warehouse.__str__", read_only=True)
    lines = TransferLineSerializer(many=True)
    line_serializer_class = TransferLineSerializer
    line_fk = "transfer"
    dispatched_by_name = serializers.CharField(source="dispatched_by.full_name", read_only=True, default=None)
    received_by_name = serializers.CharField(source="received_by.full_name", read_only=True, default=None)

    class Meta:
        model = StockTransfer
        fields = ["id", "number", "date", "source_warehouse", "source_name", "destination_warehouse", "destination_name",
                  "status", "dispatched_at", "dispatched_by_name", "received_date", "received_by_name", "notes", "lines",
                  "dispatch_movement", "receipt_movement", "created_at"]
        read_only_fields = ["number", "status", "dispatched_at", "received_date", "dispatch_movement", "receipt_movement"]

    def validate(self, attrs):
        attrs = super().validate(attrs)
        source = attrs.get("source_warehouse", getattr(self.instance, "source_warehouse", None))
        dest = attrs.get("destination_warehouse", getattr(self.instance, "destination_warehouse", None))
        if source and dest and source == dest:
            raise serializers.ValidationError({"destination_warehouse": ["Choose a different destination warehouse."]})
        products = [line["product"].pk for line in attrs.get("lines", [])]
        if len(products) != len(set(products)):
            raise serializers.ValidationError({"lines": ["List each product once per transfer."]})
        for line in attrs.get("lines", []):
            if line["quantity"] <= 0:
                raise serializers.ValidationError({"lines": ["Quantities must be positive."]})
        return attrs


class CountLineSerializer(serializers.ModelSerializer):
    id = serializers.IntegerField(required=False)
    product = OrgRelatedField(Product, extra_filter={"product_type": "STOCK"})
    sku = serializers.CharField(source="product.sku", read_only=True)
    product_name = serializers.CharField(source="product.name", read_only=True)
    unit = serializers.CharField(source="product.unit.code", read_only=True)
    difference = serializers.DecimalField(max_digits=16, decimal_places=3, read_only=True)
    system_quantity = serializers.DecimalField(max_digits=16, decimal_places=3, read_only=True)

    class Meta:
        model = StockCountLine
        fields = ["id", "product", "sku", "product_name", "unit", "system_quantity", "counted_quantity", "difference", "notes"]


class StockCountSerializer(BaseModelSerializer):
    warehouse = OrgRelatedField(Warehouse, extra_filter={"is_transit": False})
    warehouse_name = serializers.CharField(source="warehouse.__str__", read_only=True)
    lines = CountLineSerializer(many=True, required=False)
    posted_by_name = serializers.CharField(source="posted_by.full_name", read_only=True, default=None)
    line_count = serializers.SerializerMethodField()
    counted_count = serializers.SerializerMethodField()

    class Meta:
        model = StockCount
        fields = ["id", "number", "date", "warehouse", "warehouse_name", "status", "notes", "lines", "posted_by_name",
                  "posted_at", "adjustment_movement", "line_count", "counted_count", "created_at"]
        read_only_fields = ["number", "status", "posted_at", "adjustment_movement"]

    def get_line_count(self, obj):
        return obj.lines.count()

    def get_counted_count(self, obj):
        return obj.lines.exclude(counted_quantity=None).count()

    def _save_lines(self, count, lines):
        from .services import on_hand

        existing = {l.product_id: l for l in count.lines.all()}
        keep = []
        for data in lines:
            product = data["product"]
            line = existing.get(product.pk)
            if line is None:
                line = StockCountLine(count=count, product=product, system_quantity=on_hand(product, count.warehouse))
            line.counted_quantity = data.get("counted_quantity")
            line.notes = data.get("notes", "")
            line.save()
            keep.append(line.pk)
        count.lines.exclude(pk__in=keep).delete()

    def create(self, validated_data):
        lines = validated_data.pop("lines", [])
        count = StockCount.objects.create(**validated_data)
        self._save_lines(count, lines)
        return count

    def update(self, instance, validated_data):
        from apps.core.exceptions import BusinessRuleError

        if instance.status != "DRAFT":
            raise BusinessRuleError("Posted counts cannot be edited.")
        lines = validated_data.pop("lines", None)
        if "warehouse" in validated_data and validated_data["warehouse"] != instance.warehouse and instance.lines.exists():
            raise serializers.ValidationError({"warehouse": ["Remove the lines before changing the warehouse."]})
        instance = super().update(instance, validated_data)
        if lines is not None:
            self._save_lines(instance, lines)
        return instance


class BatchSerializer(BaseModelSerializer):
    sku = serializers.CharField(source="product.sku", read_only=True)
    product_name = serializers.CharField(source="product.name", read_only=True)
    quantity = serializers.DecimalField(max_digits=16, decimal_places=3, read_only=True, default=None)

    class Meta:
        model = Batch
        fields = ["id", "product", "sku", "product_name", "batch_number", "manufacture_date", "expiry_date", "quantity"]


class SerialSerializer(BaseModelSerializer):
    sku = serializers.CharField(source="product.sku", read_only=True)
    warehouse_code = serializers.CharField(source="warehouse.code", read_only=True, default=None)

    class Meta:
        model = SerialNumber
        fields = ["id", "product", "sku", "serial", "warehouse", "warehouse_code", "status", "updated_at"]


class ReservationSerializer(BaseModelSerializer):
    sku = serializers.CharField(source="product.sku", read_only=True)
    product_name = serializers.CharField(source="product.name", read_only=True)
    warehouse_code = serializers.CharField(source="warehouse.code", read_only=True)
    order_id = serializers.IntegerField(source="sales_order_line.order_id", read_only=True)
    order_number = serializers.CharField(source="sales_order_line.order.number", read_only=True)
    customer_name = serializers.CharField(source="sales_order_line.order.customer.name", read_only=True)

    class Meta:
        model = StockReservation
        fields = ["id", "product", "sku", "product_name", "warehouse", "warehouse_code", "order_id", "order_number",
                  "customer_name", "quantity", "open_quantity", "status", "created_at"]
