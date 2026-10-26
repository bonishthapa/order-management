import datetime as dt

from rest_framework import serializers

from apps.core.serializers import BaseModelSerializer, DocumentSerializer, OrgRelatedField
from apps.inventory.models import Warehouse
from apps.sales.serializers import LINE_READ_ONLY, TOTALS, PricedLineSerializer
from apps.suppliers.models import Supplier

from .models import (
    GoodsReceipt,
    GoodsReceiptLine,
    PurchaseOrder,
    PurchaseOrderLine,
    PurchaseReturn,
    PurchaseReturnLine,
    SupplierBill,
    SupplierBillLine,
)


class PurchaseOrderLineSerializer(PricedLineSerializer):
    class Meta:
        model = PurchaseOrderLine
        fields = PricedLineSerializer.base_fields + ["received_quantity", "rejected_quantity", "billed_quantity"]
        read_only_fields = LINE_READ_ONLY + ["received_quantity", "rejected_quantity", "billed_quantity"]


class PurchaseOrderSerializer(DocumentSerializer):
    supplier = OrgRelatedField(Supplier)
    warehouse = OrgRelatedField(Warehouse, extra_filter={"is_transit": False, "is_active": True})
    supplier_name = serializers.CharField(source="supplier.name", read_only=True)
    warehouse_name = serializers.CharField(source="warehouse.__str__", read_only=True)
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    lines = PurchaseOrderLineSerializer(many=True)
    submitted_by_name = serializers.CharField(source="submitted_by.full_name", read_only=True, default=None)
    approved_by_name = serializers.CharField(source="approved_by.full_name", read_only=True, default=None)
    created_by_name = serializers.CharField(source="created_by.full_name", read_only=True, default=None)
    progress = serializers.SerializerMethodField()

    line_serializer_class = PurchaseOrderLineSerializer
    line_fk = "order"
    editable_statuses = ("DRAFT", "REJECTED")
    number_doc_type = "PO"
    number_date_field = "order_date"

    class Meta:
        model = PurchaseOrder
        fields = ["id", "number", "supplier", "supplier_name", "warehouse", "warehouse_name", "order_date",
                  "expected_delivery_date", "supplier_reference", "payment_terms_days", "status", "status_label", "notes",
                  "terms", "freight", "other_charges", *TOTALS, "lines", "submitted_at", "submitted_by_name", "approved_at",
                  "approved_by_name", "rejection_reason", "cancelled_at", "cancellation_reason", "created_by_name",
                  "created_at", "updated_at", "progress"]
        read_only_fields = ["number", "status", *TOTALS, "submitted_at", "approved_at", "rejection_reason", "cancelled_at",
                            "cancellation_reason"]

    def get_progress(self, order):
        from apps.core.money import ZERO, qty

        lines = list(order.lines.all())
        totals = {
            "ordered": sum((l.quantity for l in lines), ZERO),
            "received": sum((l.received_quantity for l in lines), ZERO),
            "rejected": sum((l.rejected_quantity for l in lines), ZERO),
            "billed": sum((l.billed_quantity for l in lines), ZERO),
        }
        return {key: str(qty(value)) for key, value in totals.items()}

    def validate(self, attrs):
        attrs = super().validate(attrs)
        supplier = attrs.get("supplier")
        if supplier and not supplier.is_active:
            raise serializers.ValidationError({"supplier": ["This supplier is inactive."]})
        if supplier and self.instance is None:
            attrs.setdefault("payment_terms_days", supplier.payment_terms_days)
        expected = attrs.get("expected_delivery_date")
        order_date = attrs.get("order_date", getattr(self.instance, "order_date", None))
        if expected and order_date and expected < order_date:
            raise serializers.ValidationError({"expected_delivery_date": ["Cannot be before the order date."]})
        return attrs


class PurchaseOrderListSerializer(BaseModelSerializer):
    supplier_name = serializers.CharField(source="supplier.name", read_only=True)
    warehouse_code = serializers.CharField(source="warehouse.code", read_only=True)
    status_label = serializers.CharField(source="get_status_display", read_only=True)

    class Meta:
        model = PurchaseOrder
        fields = ["id", "number", "supplier", "supplier_name", "warehouse", "warehouse_code", "order_date",
                  "expected_delivery_date", "status", "status_label", "grand_total", "created_at"]


class GoodsReceiptLineSerializer(serializers.ModelSerializer):
    order_line = serializers.PrimaryKeyRelatedField(queryset=PurchaseOrderLine.objects.all())
    product = serializers.PrimaryKeyRelatedField(read_only=True)
    sku = serializers.CharField(source="product.sku", read_only=True)
    product_name = serializers.CharField(source="product.name", read_only=True)
    unit = serializers.CharField(source="product.unit.code", read_only=True)
    ordered_quantity = serializers.DecimalField(source="order_line.quantity", max_digits=16, decimal_places=3, read_only=True)
    track_batches = serializers.BooleanField(source="product.track_batches", read_only=True)
    track_serials = serializers.BooleanField(source="product.track_serials", read_only=True)
    track_expiry = serializers.BooleanField(source="product.track_expiry", read_only=True)

    class Meta:
        model = GoodsReceiptLine
        fields = ["id", "order_line", "product", "sku", "product_name", "unit", "ordered_quantity", "received_quantity",
                  "accepted_quantity", "rejected_quantity", "rejection_reason", "unit_cost", "batch_number",
                  "manufacture_date", "expiry_date", "serial_numbers", "billed_quantity", "track_batches", "track_serials",
                  "track_expiry"]
        read_only_fields = ["unit_cost", "billed_quantity"]
        extra_kwargs = {"accepted_quantity": {"required": False}, "rejected_quantity": {"required": False}}


class GoodsReceiptSerializer(DocumentSerializer):
    purchase_order = OrgRelatedField(PurchaseOrder)
    order_number = serializers.CharField(source="purchase_order.number", read_only=True)
    supplier_name = serializers.CharField(source="supplier.name", read_only=True)
    warehouse_name = serializers.CharField(source="warehouse.__str__", read_only=True)
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    received_by_name = serializers.CharField(source="received_by.full_name", read_only=True, default=None)
    lines = GoodsReceiptLineSerializer(many=True)
    line_serializer_class = GoodsReceiptLineSerializer
    line_fk = "receipt"

    class Meta:
        model = GoodsReceipt
        fields = ["id", "number", "fiscal_year", "purchase_order", "order_number", "supplier", "supplier_name", "warehouse",
                  "warehouse_name", "date", "supplier_delivery_note", "status", "status_label", "received_by",
                  "received_by_name", "total_value", "notes", "lines", "stock_movement", "journal", "posted_at", "created_at"]
        read_only_fields = ["number", "fiscal_year", "supplier", "warehouse", "status", "received_by", "total_value",
                            "stock_movement", "journal", "posted_at"]

    def validate(self, attrs):
        attrs = super().validate(attrs)
        order = attrs.get("purchase_order") or getattr(self.instance, "purchase_order", None)
        if order.status not in ("APPROVED", "PARTIAL"):
            raise serializers.ValidationError({"purchase_order": ["Goods can only be received against approved orders."]})
        attrs["supplier"] = order.supplier
        attrs["warehouse"] = order.warehouse
        date = attrs.get("date", getattr(self.instance, "date", None))
        if date and date < order.order_date:
            raise serializers.ValidationError({"date": ["The receipt date cannot be before the order date."]})
        for line in attrs.get("lines", []):
            ol = line["order_line"]
            if ol.order_id != order.pk:
                raise serializers.ValidationError({"lines": ["Every line must belong to the selected purchase order."]})
            line["product"] = ol.product
            line.setdefault("rejected_quantity", 0)
            if "accepted_quantity" not in line:
                line["accepted_quantity"] = line["received_quantity"] - line["rejected_quantity"]
            if line["accepted_quantity"] < 0 or line["rejected_quantity"] < 0:
                raise serializers.ValidationError({"lines": ["Quantities cannot be negative."]})
            if line["accepted_quantity"] + line["rejected_quantity"] != line["received_quantity"]:
                raise serializers.ValidationError({"lines": [f"{ol.product.sku}: accepted + rejected must equal received."]})
        return attrs


class SupplierBillLineSerializer(PricedLineSerializer):
    order_line = serializers.PrimaryKeyRelatedField(queryset=PurchaseOrderLine.objects.all(), required=False, allow_null=True)
    receipt_line = serializers.PrimaryKeyRelatedField(queryset=GoodsReceiptLine.objects.all(), required=False, allow_null=True)
    grn_number = serializers.CharField(source="receipt_line.receipt.number", read_only=True, default=None)

    class Meta:
        model = SupplierBillLine
        fields = PricedLineSerializer.base_fields + ["order_line", "receipt_line", "grn_number", "returned_quantity",
                                                     "batch_number", "expiry_date"]
        read_only_fields = LINE_READ_ONLY + ["returned_quantity"]


class SupplierBillSerializer(DocumentSerializer):
    supplier = OrgRelatedField(Supplier)
    purchase_order = OrgRelatedField(PurchaseOrder, required=False, allow_null=True)
    warehouse = OrgRelatedField(Warehouse, extra_filter={"is_transit": False}, required=False, allow_null=True)
    supplier_name = serializers.CharField(source="supplier.name", read_only=True)
    order_number = serializers.CharField(source="purchase_order.number", read_only=True, default=None)
    fiscal_year_name = serializers.CharField(source="fiscal_year.name", read_only=True, default=None)
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    payment_status_label = serializers.CharField(source="get_payment_status_display", read_only=True)
    posted_by_name = serializers.CharField(source="posted_by.full_name", read_only=True, default=None)
    lines = SupplierBillLineSerializer(many=True)
    line_serializer_class = SupplierBillLineSerializer
    line_fk = "bill"
    is_overdue = serializers.SerializerMethodField()

    class Meta:
        model = SupplierBill
        fields = ["id", "number", "fiscal_year", "fiscal_year_name", "supplier", "supplier_name", "supplier_invoice_number",
                  "purchase_order", "order_number", "warehouse", "bill_date", "due_date", "status", "status_label",
                  "payment_status", "payment_status_label", "freight", "other_charges", *TOTALS, "amount_paid",
                  "amount_credited", "balance_due", "is_overdue", "notes", "lines", "journal", "stock_movement",
                  "posted_at", "posted_by_name", "reversal_reason", "created_at"]
        read_only_fields = ["number", "fiscal_year", "status", "payment_status", *TOTALS, "amount_paid", "amount_credited",
                            "balance_due", "journal", "stock_movement", "posted_at", "reversal_reason"]
        extra_kwargs = {"due_date": {"required": False}}

    def get_is_overdue(self, obj):
        from django.utils import timezone

        return obj.status == "POSTED" and obj.balance_due > 0 and obj.due_date < timezone.localdate()

    def validate_supplier_invoice_number(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError("Enter the supplier's invoice number.")
        return value

    def validate(self, attrs):
        attrs = super().validate(attrs)
        supplier = attrs.get("supplier") or getattr(self.instance, "supplier", None)
        order = attrs.get("purchase_order", getattr(self.instance, "purchase_order", None))
        if order and order.supplier_id != supplier.pk:
            raise serializers.ValidationError({"purchase_order": ["The order belongs to another supplier."]})
        reference = attrs.get("supplier_invoice_number", getattr(self.instance, "supplier_invoice_number", ""))
        clash = SupplierBill.objects.filter(organization=self.organization, supplier=supplier,
                                            supplier_invoice_number__iexact=reference, status__in=["DRAFT", "POSTED"])
        if self.instance:
            clash = clash.exclude(pk=self.instance.pk)
        if clash.exists():
            raise serializers.ValidationError(
                {"supplier_invoice_number": [f"Already recorded on {clash.first()} for this supplier."]})
        bill_date = attrs.get("bill_date", getattr(self.instance, "bill_date", None))
        if "due_date" not in attrs and self.instance is None and bill_date:
            attrs["due_date"] = bill_date + dt.timedelta(days=(order or supplier).payment_terms_days)
        due = attrs.get("due_date", getattr(self.instance, "due_date", None))
        if due and bill_date and due < bill_date:
            raise serializers.ValidationError({"due_date": ["The due date cannot be before the bill date."]})
        if order and not attrs.get("warehouse"):
            attrs["warehouse"] = order.warehouse
        for line in attrs.get("lines", []):
            receipt_line = line.get("receipt_line")
            order_line = line.get("order_line")
            if receipt_line is not None:
                if receipt_line.receipt.supplier_id != supplier.pk or receipt_line.receipt.organization_id != self.organization.id:
                    raise serializers.ValidationError({"lines": ["Goods receipt lines must belong to this supplier."]})
                order_line = receipt_line.order_line
                line["order_line"] = order_line
                line["product"] = receipt_line.product
                line.setdefault("batch_number", receipt_line.batch_number)
            if order_line is not None:
                if order is None or order_line.order_id != order.pk:
                    raise serializers.ValidationError({"lines": ["Order lines must belong to the selected purchase order."]})
                line["product"] = order_line.product
                line.setdefault("tax_rate", order_line.tax_rate)
                line.setdefault("discount_percent", order_line.discount_percent)
        return attrs


class SupplierBillListSerializer(BaseModelSerializer):
    supplier_name = serializers.CharField(source="supplier.name", read_only=True)
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    payment_status_label = serializers.CharField(source="get_payment_status_display", read_only=True)
    order_number = serializers.CharField(source="purchase_order.number", read_only=True, default=None)

    class Meta:
        model = SupplierBill
        fields = ["id", "number", "supplier", "supplier_name", "supplier_invoice_number", "order_number", "bill_date",
                  "due_date", "status", "status_label", "payment_status", "payment_status_label", "grand_total",
                  "amount_paid", "balance_due", "created_at"]


class PurchaseReturnLineSerializer(PricedLineSerializer):
    bill_line = serializers.PrimaryKeyRelatedField(queryset=SupplierBillLine.objects.all())
    product = serializers.PrimaryKeyRelatedField(read_only=True)
    unit_price = serializers.DecimalField(max_digits=18, decimal_places=4, read_only=True)
    discount_percent = serializers.DecimalField(max_digits=7, decimal_places=4, read_only=True)
    tax_rate = serializers.PrimaryKeyRelatedField(read_only=True)

    class Meta:
        model = PurchaseReturnLine
        fields = PricedLineSerializer.base_fields + ["bill_line", "batch_number", "serial_numbers", "cost_amount"]
        read_only_fields = LINE_READ_ONLY + ["cost_amount"]


class PurchaseReturnSerializer(DocumentSerializer):
    bill = OrgRelatedField(SupplierBill, extra_filter={"status": "POSTED"})
    warehouse = OrgRelatedField(Warehouse, extra_filter={"is_transit": False})
    bill_number = serializers.CharField(source="bill.number", read_only=True)
    supplier_name = serializers.CharField(source="supplier.name", read_only=True)
    warehouse_name = serializers.CharField(source="warehouse.__str__", read_only=True)
    unapplied_credit = serializers.DecimalField(max_digits=18, decimal_places=2, read_only=True)
    lines = PurchaseReturnLineSerializer(many=True)
    line_serializer_class = PurchaseReturnLineSerializer
    line_fk = "purchase_return"

    class Meta:
        model = PurchaseReturn
        fields = ["id", "number", "fiscal_year", "bill", "bill_number", "supplier", "supplier_name", "warehouse",
                  "warehouse_name", "date", "reason", "status", *TOTALS, "credit_applied", "refunded_amount",
                  "unapplied_credit", "lines", "journal", "stock_movement", "posted_at", "created_at"]
        read_only_fields = ["number", "fiscal_year", "supplier", "status", *TOTALS, "credit_applied", "refunded_amount",
                            "journal", "stock_movement", "posted_at"]

    def validate(self, attrs):
        attrs = super().validate(attrs)
        bill = attrs.get("bill") or getattr(self.instance, "bill", None)
        attrs["supplier"] = bill.supplier
        for line in attrs.get("lines", []):
            bl = line["bill_line"]
            if bl.bill_id != bill.pk:
                raise serializers.ValidationError({"lines": ["Return lines must come from the selected bill."]})
            if line["quantity"] > bl.quantity - bl.returned_quantity:
                raise serializers.ValidationError(
                    {"lines": [f"{bl.product.sku}: at most {bl.quantity - bl.returned_quantity} can be returned."]})
            line.update(product=bl.product, unit_price=bl.unit_price, discount_percent=bl.discount_percent, tax_rate=bl.tax_rate)
            line.setdefault("description", bl.description)
            line.setdefault("batch_number", bl.batch_number)
        return attrs
