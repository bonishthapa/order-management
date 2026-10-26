import datetime as dt

from rest_framework import serializers

from apps.core.serializers import BaseModelSerializer, DocumentSerializer, OrgRelatedField
from apps.customers.models import Customer
from apps.inventory.models import Warehouse
from apps.organizations.models import TaxRate
from apps.products.models import Product

from .models import (
    Delivery,
    DeliveryLine,
    SalesInvoice,
    SalesInvoiceLine,
    SalesOrder,
    SalesOrderLine,
    SalesReturn,
    SalesReturnLine,
)

LINE_READ_ONLY = ["tax_percent", "gross_amount", "discount_amount", "taxable_amount", "tax_amount", "line_total"]
TOTALS = ["subtotal", "discount_total", "taxable_total", "tax_total", "grand_total"]


class PricedLineSerializer(serializers.ModelSerializer):
    product = OrgRelatedField(Product, extra_filter={"is_active": True})
    tax_rate = OrgRelatedField(TaxRate, required=False, allow_null=True)
    sku = serializers.CharField(source="product.sku", read_only=True)
    product_name = serializers.CharField(source="product.name", read_only=True)
    unit = serializers.CharField(source="product.unit.code", read_only=True)
    is_stock = serializers.BooleanField(source="product.is_stock", read_only=True)

    base_fields = ["id", "product", "sku", "product_name", "unit", "is_stock", "description", "quantity", "unit_price",
                   "discount_percent", "tax_rate", *LINE_READ_ONLY]

    def validate(self, attrs):
        if attrs.get("quantity") is not None and attrs["quantity"] <= 0:
            raise serializers.ValidationError({"quantity": ["Quantity must be greater than zero."]})
        product = attrs.get("product")
        if product and attrs.get("quantity") and not product.unit.allow_fractions and attrs["quantity"] % 1:
            raise serializers.ValidationError({"quantity": [f"{product.sku} is sold in whole {product.unit.code}."]})
        return attrs


class SalesOrderLineSerializer(PricedLineSerializer):
    class Meta:
        model = SalesOrderLine
        fields = PricedLineSerializer.base_fields + ["reserved_quantity", "delivered_quantity", "invoiced_quantity"]
        read_only_fields = LINE_READ_ONLY + ["reserved_quantity", "delivered_quantity", "invoiced_quantity"]


class SalesOrderSerializer(DocumentSerializer):
    customer = OrgRelatedField(Customer)
    warehouse = OrgRelatedField(Warehouse, extra_filter={"is_transit": False, "is_active": True})
    customer_name = serializers.CharField(source="customer.name", read_only=True)
    warehouse_name = serializers.CharField(source="warehouse.__str__", read_only=True)
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    lines = SalesOrderLineSerializer(many=True)
    submitted_by_name = serializers.CharField(source="submitted_by.full_name", read_only=True, default=None)
    approved_by_name = serializers.CharField(source="approved_by.full_name", read_only=True, default=None)
    created_by_name = serializers.CharField(source="created_by.full_name", read_only=True, default=None)
    fulfilment = serializers.SerializerMethodField()

    line_serializer_class = SalesOrderLineSerializer
    line_fk = "order"
    editable_statuses = ("DRAFT", "REJECTED")
    number_doc_type = "SO"
    number_date_field = "order_date"

    class Meta:
        model = SalesOrder
        fields = ["id", "number", "customer", "customer_name", "warehouse", "warehouse_name", "order_date",
                  "expected_delivery_date", "customer_reference", "payment_terms_days", "shipping_address", "status",
                  "status_label", "notes", "terms", "freight", "other_charges", *TOTALS, "lines", "submitted_at",
                  "submitted_by_name", "approved_at", "approved_by_name", "rejection_reason", "cancelled_at",
                  "cancellation_reason", "created_by_name", "created_at", "updated_at", "fulfilment"]
        read_only_fields = ["number", "status", *TOTALS, "submitted_at", "approved_at", "rejection_reason", "cancelled_at",
                            "cancellation_reason"]

    def get_fulfilment(self, order):
        from apps.core.money import ZERO, qty

        lines = list(order.lines.all())
        open_order = order.status in ("APPROVED", "PARTIAL")
        totals = {
            "ordered": sum((l.quantity for l in lines), ZERO),
            "reserved": sum((l.reserved_quantity for l in lines), ZERO),
            "delivered": sum((l.delivered_quantity for l in lines), ZERO),
            "invoiced": sum((l.invoiced_quantity for l in lines), ZERO),
            "backorder": sum((max(l.quantity - l.delivered_quantity - l.reserved_quantity, ZERO) for l in lines), ZERO)
            if open_order else ZERO,
        }
        return {key: str(qty(value)) for key, value in totals.items()}

    def validate(self, attrs):
        attrs = super().validate(attrs)
        customer = attrs.get("customer")
        if customer and not customer.is_active:
            raise serializers.ValidationError({"customer": ["This customer is inactive."]})
        if customer and self.instance is None:
            attrs.setdefault("payment_terms_days", customer.payment_terms_days)
            if not attrs.get("shipping_address"):
                attrs["shipping_address"] = customer.shipping_address or customer.billing_address
            if not attrs.get("terms"):
                attrs["terms"] = self.organization.terms_and_conditions
        expected = attrs.get("expected_delivery_date")
        order_date = attrs.get("order_date", getattr(self.instance, "order_date", None))
        if expected and order_date and expected < order_date:
            raise serializers.ValidationError({"expected_delivery_date": ["Cannot be before the order date."]})
        return attrs


class SalesOrderListSerializer(BaseModelSerializer):
    customer_name = serializers.CharField(source="customer.name", read_only=True)
    warehouse_code = serializers.CharField(source="warehouse.code", read_only=True)
    status_label = serializers.CharField(source="get_status_display", read_only=True)

    class Meta:
        model = SalesOrder
        fields = ["id", "number", "customer", "customer_name", "warehouse", "warehouse_code", "order_date",
                  "expected_delivery_date", "status", "status_label", "grand_total", "created_at"]


class DeliveryLineSerializer(serializers.ModelSerializer):
    order_line = serializers.PrimaryKeyRelatedField(queryset=SalesOrderLine.objects.all())
    product = serializers.PrimaryKeyRelatedField(read_only=True)
    sku = serializers.CharField(source="product.sku", read_only=True)
    product_name = serializers.CharField(source="product.name", read_only=True)
    unit = serializers.CharField(source="product.unit.code", read_only=True)
    ordered_quantity = serializers.DecimalField(source="order_line.quantity", max_digits=16, decimal_places=3, read_only=True)

    class Meta:
        model = DeliveryLine
        fields = ["id", "order_line", "product", "sku", "product_name", "unit", "ordered_quantity", "quantity",
                  "batch_number", "serial_numbers", "unit_cost", "cost_amount"]
        read_only_fields = ["unit_cost", "cost_amount"]


class DeliverySerializer(DocumentSerializer):
    sales_order = OrgRelatedField(SalesOrder)
    order_number = serializers.CharField(source="sales_order.number", read_only=True)
    customer_name = serializers.CharField(source="customer.name", read_only=True)
    warehouse_name = serializers.CharField(source="warehouse.__str__", read_only=True)
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    posted_by_name = serializers.CharField(source="posted_by.full_name", read_only=True, default=None)
    lines = DeliveryLineSerializer(many=True)
    line_serializer_class = DeliveryLineSerializer
    line_fk = "delivery"

    class Meta:
        model = Delivery
        fields = ["id", "number", "sales_order", "order_number", "customer", "customer_name", "warehouse", "warehouse_name",
                  "date", "shipping_address", "vehicle_number", "status", "status_label", "notes", "lines",
                  "stock_movement", "journal", "posted_at", "posted_by_name", "created_at"]
        read_only_fields = ["number", "customer", "warehouse", "status", "stock_movement", "journal", "posted_at"]

    def validate(self, attrs):
        attrs = super().validate(attrs)
        order = attrs.get("sales_order") or getattr(self.instance, "sales_order", None)
        if order.status not in ("APPROVED", "PARTIAL"):
            raise serializers.ValidationError({"sales_order": ["Only approved orders can be delivered."]})
        attrs["customer"] = order.customer
        attrs["warehouse"] = order.warehouse
        if not attrs.get("shipping_address") and self.instance is None:
            attrs["shipping_address"] = order.shipping_address
        date = attrs.get("date", getattr(self.instance, "date", None))
        if date and date < order.order_date:
            raise serializers.ValidationError({"date": ["The delivery date cannot be before the order date."]})
        for line in attrs.get("lines", []):
            if line["order_line"].order_id != order.pk:
                raise serializers.ValidationError({"lines": ["Every line must belong to the selected order."]})
            if line["quantity"] <= 0:
                raise serializers.ValidationError({"lines": ["Quantities must be positive."]})
            line["product"] = line["order_line"].product
        return attrs


class SalesInvoiceLineSerializer(PricedLineSerializer):
    order_line = serializers.PrimaryKeyRelatedField(queryset=SalesOrderLine.objects.all(), required=False, allow_null=True)

    class Meta:
        model = SalesInvoiceLine
        fields = PricedLineSerializer.base_fields + ["order_line", "batch_number", "serial_numbers", "unit_cost",
                                                     "returned_quantity"]
        read_only_fields = LINE_READ_ONLY + ["unit_cost", "returned_quantity"]


class SalesInvoiceSerializer(DocumentSerializer):
    customer = OrgRelatedField(Customer)
    sales_order = OrgRelatedField(SalesOrder, required=False, allow_null=True)
    warehouse = OrgRelatedField(Warehouse, extra_filter={"is_transit": False}, required=False, allow_null=True)
    customer_display = serializers.CharField(source="customer.name", read_only=True)
    order_number = serializers.CharField(source="sales_order.number", read_only=True, default=None)
    fiscal_year_name = serializers.CharField(source="fiscal_year.name", read_only=True, default=None)
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    payment_status_label = serializers.CharField(source="get_payment_status_display", read_only=True)
    posted_by_name = serializers.CharField(source="posted_by.full_name", read_only=True, default=None)
    lines = SalesInvoiceLineSerializer(many=True)
    line_serializer_class = SalesInvoiceLineSerializer
    line_fk = "invoice"
    is_overdue = serializers.SerializerMethodField()

    class Meta:
        model = SalesInvoice
        fields = ["id", "number", "fiscal_year", "fiscal_year_name", "customer", "customer_display", "sales_order",
                  "order_number", "warehouse", "invoice_date", "due_date", "customer_name", "customer_address",
                  "customer_tax_id", "customer_reference", "status", "status_label", "payment_status",
                  "payment_status_label", "freight", "other_charges", *TOTALS, "amount_paid", "amount_credited",
                  "balance_due", "is_overdue", "notes", "terms", "lines", "journal", "cogs_journal", "stock_movement",
                  "posted_at", "posted_by_name", "reversal_reason", "print_count", "created_at"]
        read_only_fields = ["number", "fiscal_year", "status", "payment_status", *TOTALS, "amount_paid", "amount_credited",
                            "balance_due", "journal", "cogs_journal", "stock_movement", "posted_at", "reversal_reason",
                            "print_count"]
        extra_kwargs = {"due_date": {"required": False}}

    def get_is_overdue(self, obj):
        from django.utils import timezone

        return obj.status == "POSTED" and obj.balance_due > 0 and obj.due_date < timezone.localdate()

    def validate(self, attrs):
        attrs = super().validate(attrs)
        customer = attrs.get("customer") or getattr(self.instance, "customer", None)
        order = attrs.get("sales_order", getattr(self.instance, "sales_order", None))
        if order and order.customer_id != customer.pk:
            raise serializers.ValidationError({"sales_order": ["The order belongs to another customer."]})
        invoice_date = attrs.get("invoice_date", getattr(self.instance, "invoice_date", None))
        if "due_date" not in attrs and self.instance is None and invoice_date:
            attrs["due_date"] = invoice_date + dt.timedelta(days=(order or customer).payment_terms_days)
        due = attrs.get("due_date", getattr(self.instance, "due_date", None))
        if due and invoice_date and due < invoice_date:
            raise serializers.ValidationError({"due_date": ["The due date cannot be before the invoice date."]})
        if order and not attrs.get("warehouse"):
            attrs["warehouse"] = order.warehouse
        if self.instance is None and not attrs.get("terms"):
            attrs["terms"] = self.organization.terms_and_conditions
        for line in attrs.get("lines", []):
            order_line = line.get("order_line")
            if order_line is not None:
                if order is None or order_line.order_id != order.pk:
                    raise serializers.ValidationError({"lines": ["Order lines must belong to the selected order."]})
                # Price, discount and tax come from the approved order, not from the client.
                line.update(product=order_line.product, unit_price=order_line.unit_price,
                            discount_percent=order_line.discount_percent, tax_rate=order_line.tax_rate)
                line.setdefault("description", order_line.description)
            elif order is not None:
                raise serializers.ValidationError({"lines": ["Lines of an order invoice must reference order lines."]})
        return attrs


class SalesInvoiceListSerializer(BaseModelSerializer):
    customer_display = serializers.CharField(source="customer.name", read_only=True)
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    payment_status_label = serializers.CharField(source="get_payment_status_display", read_only=True)
    order_number = serializers.CharField(source="sales_order.number", read_only=True, default=None)

    class Meta:
        model = SalesInvoice
        fields = ["id", "number", "customer", "customer_display", "order_number", "invoice_date", "due_date", "status",
                  "status_label", "payment_status", "payment_status_label", "grand_total", "amount_paid", "balance_due",
                  "created_at"]


class SalesReturnLineSerializer(PricedLineSerializer):
    invoice_line = serializers.PrimaryKeyRelatedField(queryset=SalesInvoiceLine.objects.all())
    product = serializers.PrimaryKeyRelatedField(read_only=True)
    unit_price = serializers.DecimalField(max_digits=18, decimal_places=4, read_only=True)
    discount_percent = serializers.DecimalField(max_digits=7, decimal_places=4, read_only=True)
    tax_rate = serializers.PrimaryKeyRelatedField(read_only=True)

    class Meta:
        model = SalesReturnLine
        fields = PricedLineSerializer.base_fields + ["invoice_line", "inspection", "unit_cost", "batch_number", "serial_numbers"]
        read_only_fields = LINE_READ_ONLY + ["unit_cost"]


class SalesReturnSerializer(DocumentSerializer):
    invoice = OrgRelatedField(SalesInvoice, extra_filter={"status": "POSTED"})
    warehouse = OrgRelatedField(Warehouse, extra_filter={"is_transit": False})
    invoice_number = serializers.CharField(source="invoice.number", read_only=True)
    customer_name = serializers.CharField(source="customer.name", read_only=True)
    warehouse_name = serializers.CharField(source="warehouse.__str__", read_only=True)
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    unapplied_credit = serializers.DecimalField(max_digits=18, decimal_places=2, read_only=True)
    lines = SalesReturnLineSerializer(many=True)
    line_serializer_class = SalesReturnLineSerializer
    line_fk = "sales_return"

    class Meta:
        model = SalesReturn
        fields = ["id", "number", "fiscal_year", "invoice", "invoice_number", "customer", "customer_name", "warehouse",
                  "warehouse_name", "date", "reason", "status", "status_label", *TOTALS, "credit_applied",
                  "refunded_amount", "unapplied_credit", "lines", "journal", "stock_movement", "posted_at", "created_at"]
        read_only_fields = ["number", "fiscal_year", "customer", "status", *TOTALS, "credit_applied", "refunded_amount",
                            "journal", "stock_movement", "posted_at"]

    def validate(self, attrs):
        attrs = super().validate(attrs)
        invoice = attrs.get("invoice") or getattr(self.instance, "invoice", None)
        attrs["customer"] = invoice.customer
        for line in attrs.get("lines", []):
            il = line["invoice_line"]
            if il.invoice_id != invoice.pk:
                raise serializers.ValidationError({"lines": ["Return lines must come from the selected invoice."]})
            if line["quantity"] > il.quantity - il.returned_quantity:
                raise serializers.ValidationError(
                    {"lines": [f"{il.product.sku}: at most {il.quantity - il.returned_quantity} can be returned."]})
            line.update(product=il.product, unit_price=il.unit_price, discount_percent=il.discount_percent, tax_rate=il.tax_rate)
            line.setdefault("description", il.description)
        return attrs
