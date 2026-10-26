from django.conf import settings
from django.db import models
from django.db.models import Q

from apps.core.documents import PricedDocument, PricedLine
from apps.core.models import OrganizationOwned
from apps.core.money import MONEY_DIGITS, QTY_DIGITS, RATE_DIGITS


class PurchaseOrderStatus(models.TextChoices):
    DRAFT = "DRAFT", "Draft"
    SUBMITTED = "SUBMITTED", "Awaiting approval"
    APPROVED = "APPROVED", "Approved"
    REJECTED = "REJECTED", "Rejected"
    PARTIAL = "PARTIAL", "Partially received"
    COMPLETED = "COMPLETED", "Completed"
    CANCELLED = "CANCELLED", "Cancelled"


class PurchaseOrder(OrganizationOwned, PricedDocument):
    number = models.CharField(max_length=40)
    supplier = models.ForeignKey("suppliers.Supplier", on_delete=models.PROTECT, related_name="purchase_orders")
    warehouse = models.ForeignKey("inventory.Warehouse", on_delete=models.PROTECT, related_name="+")
    order_date = models.DateField()
    expected_delivery_date = models.DateField(null=True, blank=True)
    supplier_reference = models.CharField(max_length=60, blank=True)
    payment_terms_days = models.PositiveSmallIntegerField(default=30)
    status = models.CharField(max_length=10, choices=PurchaseOrderStatus.choices, default=PurchaseOrderStatus.DRAFT)
    notes = models.TextField(blank=True)
    terms = models.TextField(blank=True)
    submitted_at = models.DateTimeField(null=True, blank=True)
    submitted_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    approved_at = models.DateTimeField(null=True, blank=True)
    approved_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    rejection_reason = models.TextField(blank=True)
    cancelled_at = models.DateTimeField(null=True, blank=True)
    cancellation_reason = models.TextField(blank=True)

    class Meta:
        ordering = ["-order_date", "-id"]
        constraints = [models.UniqueConstraint(fields=["organization", "number"], name="uniq_purchase_order_number")]
        indexes = [models.Index(fields=["organization", "order_date"]), models.Index(fields=["organization", "status"])]

    def __str__(self):
        return self.number


class PurchaseOrderLine(PricedLine):
    order = models.ForeignKey(PurchaseOrder, on_delete=models.CASCADE, related_name="lines")
    received_quantity = models.DecimalField(**QTY_DIGITS, default=0, help_text="Accepted into stock")
    rejected_quantity = models.DecimalField(**QTY_DIGITS, default=0)
    billed_quantity = models.DecimalField(**QTY_DIGITS, default=0)

    class Meta:
        ordering = ["order", "id"]
        constraints = [
            models.CheckConstraint(condition=Q(quantity__gt=0), name="po_line_qty_positive"),
            models.CheckConstraint(condition=Q(received_quantity__lte=models.F("quantity")), name="po_line_no_over_receipt"),
        ]

    @property
    def pending_quantity(self):
        return self.quantity - self.received_quantity


class GRNStatus(models.TextChoices):
    DRAFT = "DRAFT", "Draft"
    POSTED = "POSTED", "Posted"
    CANCELLED = "CANCELLED", "Cancelled"
    REVERSED = "REVERSED", "Reversed"


class GoodsReceipt(OrganizationOwned):
    number = models.CharField(max_length=40, blank=True)
    fiscal_year = models.ForeignKey("fiscal_years.FiscalYear", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    purchase_order = models.ForeignKey(PurchaseOrder, on_delete=models.PROTECT, related_name="receipts")
    supplier = models.ForeignKey("suppliers.Supplier", on_delete=models.PROTECT, related_name="goods_receipts")
    warehouse = models.ForeignKey("inventory.Warehouse", on_delete=models.PROTECT, related_name="+")
    date = models.DateField()
    supplier_delivery_note = models.CharField(max_length=60, blank=True)
    status = models.CharField(max_length=10, choices=GRNStatus.choices, default=GRNStatus.DRAFT)
    received_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    stock_movement = models.ForeignKey("inventory.StockMovement", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    journal = models.ForeignKey("accounting.JournalEntry", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    total_value = models.DecimalField(**MONEY_DIGITS, default=0)
    posted_at = models.DateTimeField(null=True, blank=True)
    notes = models.TextField(blank=True)

    class Meta:
        ordering = ["-date", "-id"]
        constraints = [models.UniqueConstraint(fields=["organization", "number"], condition=~Q(number=""), name="uniq_grn_number")]

    def __str__(self):
        return self.number or f"Draft GRN #{self.pk}"


class GoodsReceiptLine(models.Model):
    receipt = models.ForeignKey(GoodsReceipt, on_delete=models.CASCADE, related_name="lines")
    order_line = models.ForeignKey(PurchaseOrderLine, on_delete=models.PROTECT, related_name="receipt_lines")
    product = models.ForeignKey("products.Product", on_delete=models.PROTECT, related_name="+")
    received_quantity = models.DecimalField(**QTY_DIGITS)
    accepted_quantity = models.DecimalField(**QTY_DIGITS)
    rejected_quantity = models.DecimalField(**QTY_DIGITS, default=0)
    rejection_reason = models.CharField(max_length=255, blank=True)
    unit_cost = models.DecimalField(**RATE_DIGITS, default=0, help_text="PO net rate, excluding tax")
    batch_number = models.CharField(max_length=60, blank=True)
    manufacture_date = models.DateField(null=True, blank=True)
    expiry_date = models.DateField(null=True, blank=True)
    serial_numbers = models.JSONField(default=list, blank=True)
    billed_quantity = models.DecimalField(**QTY_DIGITS, default=0)

    class Meta:
        ordering = ["receipt", "id"]
        constraints = [
            models.CheckConstraint(
                condition=Q(received_quantity=models.F("accepted_quantity") + models.F("rejected_quantity")),
                name="grn_line_received_split",
            ),
            models.CheckConstraint(condition=Q(received_quantity__gt=0), name="grn_line_qty_positive"),
            models.CheckConstraint(condition=Q(billed_quantity__lte=models.F("accepted_quantity")), name="grn_line_no_over_bill"),
        ]

    @property
    def value(self):
        return self.accepted_quantity * self.unit_cost


class BillStatus(models.TextChoices):
    DRAFT = "DRAFT", "Draft"
    POSTED = "POSTED", "Posted"
    CANCELLED = "CANCELLED", "Cancelled"
    REVERSED = "REVERSED", "Reversed"


class SupplierBill(OrganizationOwned, PricedDocument):
    number = models.CharField(max_length=40, blank=True)
    fiscal_year = models.ForeignKey("fiscal_years.FiscalYear", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    supplier = models.ForeignKey("suppliers.Supplier", on_delete=models.PROTECT, related_name="bills")
    supplier_invoice_number = models.CharField(max_length=60)
    purchase_order = models.ForeignKey(PurchaseOrder, on_delete=models.PROTECT, null=True, blank=True, related_name="bills")
    warehouse = models.ForeignKey(
        "inventory.Warehouse", on_delete=models.PROTECT, null=True, blank=True, related_name="+",
        help_text="Required for direct bills of stock items (stock is received when the bill is posted).",
    )
    bill_date = models.DateField()
    due_date = models.DateField()
    status = models.CharField(max_length=10, choices=BillStatus.choices, default=BillStatus.DRAFT)
    payment_status = models.CharField(max_length=8, choices=[("UNPAID", "Unpaid"), ("PARTIAL", "Partially paid"), ("PAID", "Paid")], default="UNPAID")
    amount_paid = models.DecimalField(**MONEY_DIGITS, default=0)
    amount_credited = models.DecimalField(**MONEY_DIGITS, default=0)
    balance_due = models.DecimalField(**MONEY_DIGITS, default=0)
    journal = models.ForeignKey("accounting.JournalEntry", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    stock_movement = models.ForeignKey("inventory.StockMovement", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    posted_at = models.DateTimeField(null=True, blank=True)
    posted_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    reversal_reason = models.TextField(blank=True)
    notes = models.TextField(blank=True)

    class Meta:
        ordering = ["-bill_date", "-id"]
        constraints = [
            models.UniqueConstraint(fields=["organization", "number"], condition=~Q(number=""), name="uniq_bill_number"),
            models.UniqueConstraint(
                fields=["organization", "supplier", "supplier_invoice_number"],
                condition=Q(status__in=["DRAFT", "POSTED"]),
                name="uniq_supplier_invoice_reference",
            ),
            models.CheckConstraint(condition=Q(due_date__gte=models.F("bill_date")), name="bill_due_after_date"),
        ]
        indexes = [models.Index(fields=["organization", "bill_date"]), models.Index(fields=["organization", "supplier", "status"])]

    def __str__(self):
        return self.number or f"Draft bill #{self.pk}"


class SupplierBillLine(PricedLine):
    bill = models.ForeignKey(SupplierBill, on_delete=models.CASCADE, related_name="lines")
    order_line = models.ForeignKey(PurchaseOrderLine, on_delete=models.PROTECT, null=True, blank=True, related_name="bill_lines")
    receipt_line = models.ForeignKey(GoodsReceiptLine, on_delete=models.PROTECT, null=True, blank=True, related_name="bill_lines")
    returned_quantity = models.DecimalField(**QTY_DIGITS, default=0)
    batch_number = models.CharField(max_length=60, blank=True)
    expiry_date = models.DateField(null=True, blank=True)

    class Meta:
        ordering = ["bill", "id"]
        constraints = [
            models.CheckConstraint(condition=Q(quantity__gt=0), name="bill_line_qty_positive"),
            models.CheckConstraint(condition=Q(returned_quantity__lte=models.F("quantity")), name="bill_line_no_over_return"),
        ]


class PurchaseReturn(OrganizationOwned, PricedDocument):
    """Goods returned to a supplier. Posting reduces stock and raises a debit note against the payable."""

    number = models.CharField(max_length=40, blank=True)
    fiscal_year = models.ForeignKey("fiscal_years.FiscalYear", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    bill = models.ForeignKey(SupplierBill, on_delete=models.PROTECT, related_name="returns")
    supplier = models.ForeignKey("suppliers.Supplier", on_delete=models.PROTECT, related_name="returns")
    warehouse = models.ForeignKey("inventory.Warehouse", on_delete=models.PROTECT, related_name="+")
    date = models.DateField()
    reason = models.TextField()
    status = models.CharField(max_length=10, choices=[("DRAFT", "Draft"), ("POSTED", "Posted"), ("CANCELLED", "Cancelled")], default="DRAFT")
    credit_applied = models.DecimalField(**MONEY_DIGITS, default=0)
    refunded_amount = models.DecimalField(**MONEY_DIGITS, default=0)
    journal = models.ForeignKey("accounting.JournalEntry", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    stock_movement = models.ForeignKey("inventory.StockMovement", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    posted_at = models.DateTimeField(null=True, blank=True)
    posted_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+")

    class Meta:
        ordering = ["-date", "-id"]
        constraints = [models.UniqueConstraint(fields=["organization", "number"], condition=~Q(number=""), name="uniq_purchase_return_number")]

    def __str__(self):
        return self.number or f"Draft purchase return #{self.pk}"

    @property
    def unapplied_credit(self):
        return self.grand_total - self.credit_applied - self.refunded_amount


class PurchaseReturnLine(PricedLine):
    purchase_return = models.ForeignKey(PurchaseReturn, on_delete=models.CASCADE, related_name="lines")
    bill_line = models.ForeignKey(SupplierBillLine, on_delete=models.PROTECT, related_name="return_lines")
    batch_number = models.CharField(max_length=60, blank=True)
    serial_numbers = models.JSONField(default=list, blank=True)
    cost_amount = models.DecimalField(**MONEY_DIGITS, default=0, help_text="FIFO inventory cost removed")

    class Meta:
        ordering = ["purchase_return", "id"]
        constraints = [models.CheckConstraint(condition=Q(quantity__gt=0), name="purchase_return_qty_positive")]
