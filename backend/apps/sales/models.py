from django.conf import settings
from django.db import models
from django.db.models import Q

from apps.core.documents import PricedDocument, PricedLine
from apps.core.models import OrganizationOwned
from apps.core.money import MONEY_DIGITS, QTY_DIGITS, RATE_DIGITS


class SalesOrderStatus(models.TextChoices):
    DRAFT = "DRAFT", "Draft"
    SUBMITTED = "SUBMITTED", "Awaiting approval"
    APPROVED = "APPROVED", "Approved"
    REJECTED = "REJECTED", "Rejected"
    PARTIAL = "PARTIAL", "Partially delivered"
    COMPLETED = "COMPLETED", "Completed"
    CANCELLED = "CANCELLED", "Cancelled"


class SalesOrder(OrganizationOwned, PricedDocument):
    number = models.CharField(max_length=40)
    customer = models.ForeignKey("customers.Customer", on_delete=models.PROTECT, related_name="sales_orders")
    warehouse = models.ForeignKey("inventory.Warehouse", on_delete=models.PROTECT, related_name="+")
    order_date = models.DateField()
    expected_delivery_date = models.DateField(null=True, blank=True)
    customer_reference = models.CharField(max_length=60, blank=True)
    payment_terms_days = models.PositiveSmallIntegerField(default=30)
    shipping_address = models.TextField(blank=True)
    status = models.CharField(max_length=10, choices=SalesOrderStatus.choices, default=SalesOrderStatus.DRAFT)
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
        constraints = [models.UniqueConstraint(fields=["organization", "number"], name="uniq_sales_order_number")]
        indexes = [models.Index(fields=["organization", "order_date"]), models.Index(fields=["organization", "status"])]

    def __str__(self):
        return self.number


class SalesOrderLine(PricedLine):
    order = models.ForeignKey(SalesOrder, on_delete=models.CASCADE, related_name="lines")
    reserved_quantity = models.DecimalField(**QTY_DIGITS, default=0)
    delivered_quantity = models.DecimalField(**QTY_DIGITS, default=0)
    invoiced_quantity = models.DecimalField(**QTY_DIGITS, default=0)

    class Meta:
        ordering = ["order", "id"]
        constraints = [
            models.CheckConstraint(condition=Q(quantity__gt=0), name="so_line_qty_positive"),
            models.CheckConstraint(condition=Q(delivered_quantity__lte=models.F("quantity")), name="so_line_no_over_delivery"),
            models.CheckConstraint(condition=Q(invoiced_quantity__lte=models.F("quantity")), name="so_line_no_over_invoice"),
        ]

    @property
    def backorder_quantity(self):
        return self.quantity - self.delivered_quantity


class DeliveryStatus(models.TextChoices):
    DRAFT = "DRAFT", "Draft"
    POSTED = "POSTED", "Dispatched"
    CANCELLED = "CANCELLED", "Cancelled"
    REVERSED = "REVERSED", "Reversed"


class Delivery(OrganizationOwned):
    number = models.CharField(max_length=40, blank=True)
    sales_order = models.ForeignKey(SalesOrder, on_delete=models.PROTECT, related_name="deliveries")
    customer = models.ForeignKey("customers.Customer", on_delete=models.PROTECT, related_name="deliveries")
    warehouse = models.ForeignKey("inventory.Warehouse", on_delete=models.PROTECT, related_name="+")
    date = models.DateField()
    shipping_address = models.TextField(blank=True)
    vehicle_number = models.CharField(max_length=40, blank=True)
    status = models.CharField(max_length=10, choices=DeliveryStatus.choices, default=DeliveryStatus.DRAFT)
    stock_movement = models.ForeignKey("inventory.StockMovement", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    journal = models.ForeignKey("accounting.JournalEntry", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    posted_at = models.DateTimeField(null=True, blank=True)
    posted_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    notes = models.TextField(blank=True)

    class Meta:
        ordering = ["-date", "-id"]
        verbose_name_plural = "deliveries"
        constraints = [models.UniqueConstraint(fields=["organization", "number"], condition=~Q(number=""), name="uniq_delivery_number")]

    def __str__(self):
        return self.number or f"Draft delivery #{self.pk}"


class DeliveryLine(models.Model):
    delivery = models.ForeignKey(Delivery, on_delete=models.CASCADE, related_name="lines")
    order_line = models.ForeignKey(SalesOrderLine, on_delete=models.PROTECT, related_name="delivery_lines")
    product = models.ForeignKey("products.Product", on_delete=models.PROTECT, related_name="+")
    quantity = models.DecimalField(**QTY_DIGITS)
    batch_number = models.CharField(max_length=60, blank=True)
    serial_numbers = models.JSONField(default=list, blank=True)
    unit_cost = models.DecimalField(**RATE_DIGITS, default=0)
    cost_amount = models.DecimalField(**MONEY_DIGITS, default=0)

    class Meta:
        ordering = ["delivery", "id"]
        constraints = [models.CheckConstraint(condition=Q(quantity__gt=0), name="delivery_line_qty_positive")]


class InvoiceStatus(models.TextChoices):
    DRAFT = "DRAFT", "Draft"
    POSTED = "POSTED", "Posted"
    CANCELLED = "CANCELLED", "Cancelled"
    REVERSED = "REVERSED", "Reversed"


class PaymentStatus(models.TextChoices):
    UNPAID = "UNPAID", "Unpaid"
    PARTIAL = "PARTIAL", "Partially paid"
    PAID = "PAID", "Paid"


class SalesInvoice(OrganizationOwned, PricedDocument):
    number = models.CharField(max_length=40, blank=True)
    fiscal_year = models.ForeignKey("fiscal_years.FiscalYear", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    customer = models.ForeignKey("customers.Customer", on_delete=models.PROTECT, related_name="invoices")
    sales_order = models.ForeignKey(SalesOrder, on_delete=models.PROTECT, null=True, blank=True, related_name="invoices")
    warehouse = models.ForeignKey(
        "inventory.Warehouse", on_delete=models.PROTECT, null=True, blank=True, related_name="+",
        help_text="Required for direct invoices of stock items (stock is issued when the invoice is posted).",
    )
    invoice_date = models.DateField()
    due_date = models.DateField()
    customer_name = models.CharField(max_length=200, blank=True)
    customer_address = models.TextField(blank=True)
    customer_tax_id = models.CharField(max_length=40, blank=True)
    customer_reference = models.CharField(max_length=60, blank=True)
    status = models.CharField(max_length=10, choices=InvoiceStatus.choices, default=InvoiceStatus.DRAFT)
    payment_status = models.CharField(max_length=8, choices=PaymentStatus.choices, default=PaymentStatus.UNPAID)
    amount_paid = models.DecimalField(**MONEY_DIGITS, default=0, help_text="Σ active receipt allocations (maintained by the server)")
    amount_credited = models.DecimalField(**MONEY_DIGITS, default=0, help_text="Σ active credit-note allocations")
    balance_due = models.DecimalField(**MONEY_DIGITS, default=0)
    journal = models.ForeignKey("accounting.JournalEntry", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    stock_movement = models.ForeignKey("inventory.StockMovement", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    cogs_journal = models.ForeignKey("accounting.JournalEntry", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    posted_at = models.DateTimeField(null=True, blank=True)
    posted_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    reversal_reason = models.TextField(blank=True)
    notes = models.TextField(blank=True)
    terms = models.TextField(blank=True)
    print_count = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["-invoice_date", "-id"]
        constraints = [
            models.UniqueConstraint(fields=["organization", "number"], condition=~Q(number=""), name="uniq_invoice_number"),
            models.CheckConstraint(condition=Q(due_date__gte=models.F("invoice_date")), name="invoice_due_after_date"),
        ]
        indexes = [
            models.Index(fields=["organization", "invoice_date"]),
            models.Index(fields=["organization", "customer", "status"]),
        ]

    def __str__(self):
        return self.number or f"Draft invoice #{self.pk}"


class SalesInvoiceLine(PricedLine):
    invoice = models.ForeignKey(SalesInvoice, on_delete=models.CASCADE, related_name="lines")
    order_line = models.ForeignKey(SalesOrderLine, on_delete=models.PROTECT, null=True, blank=True, related_name="invoice_lines")
    batch_number = models.CharField(max_length=60, blank=True)
    serial_numbers = models.JSONField(default=list, blank=True)
    unit_cost = models.DecimalField(**RATE_DIGITS, default=0, help_text="FIFO cost when the invoice issued stock directly")
    returned_quantity = models.DecimalField(**QTY_DIGITS, default=0)

    class Meta:
        ordering = ["invoice", "id"]
        constraints = [
            models.CheckConstraint(condition=Q(quantity__gt=0), name="invoice_line_qty_positive"),
            models.CheckConstraint(condition=Q(returned_quantity__lte=models.F("quantity")), name="invoice_line_no_over_return"),
        ]


class ReturnStatus(models.TextChoices):
    DRAFT = "DRAFT", "Draft"
    POSTED = "POSTED", "Posted"
    CANCELLED = "CANCELLED", "Cancelled"


class InspectionStatus(models.TextChoices):
    PENDING = "PENDING", "Pending inspection"
    RESTOCK = "RESTOCK", "Good – restock"
    DAMAGED = "DAMAGED", "Damaged – not restocked"


class SalesReturn(OrganizationOwned, PricedDocument):
    """Goods returned by a customer. Posting issues a credit note for the return value."""

    number = models.CharField(max_length=40, blank=True)
    fiscal_year = models.ForeignKey("fiscal_years.FiscalYear", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    invoice = models.ForeignKey(SalesInvoice, on_delete=models.PROTECT, related_name="returns")
    customer = models.ForeignKey("customers.Customer", on_delete=models.PROTECT, related_name="returns")
    warehouse = models.ForeignKey("inventory.Warehouse", on_delete=models.PROTECT, related_name="+")
    date = models.DateField()
    reason = models.TextField()
    status = models.CharField(max_length=10, choices=ReturnStatus.choices, default=ReturnStatus.DRAFT)
    credit_applied = models.DecimalField(**MONEY_DIGITS, default=0, help_text="Credit allocated to invoices")
    refunded_amount = models.DecimalField(**MONEY_DIGITS, default=0)
    journal = models.ForeignKey("accounting.JournalEntry", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    stock_movement = models.ForeignKey("inventory.StockMovement", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    posted_at = models.DateTimeField(null=True, blank=True)
    posted_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+")

    class Meta:
        ordering = ["-date", "-id"]
        constraints = [models.UniqueConstraint(fields=["organization", "number"], condition=~Q(number=""), name="uniq_sales_return_number")]

    def __str__(self):
        return self.number or f"Draft return #{self.pk}"

    @property
    def unapplied_credit(self):
        return self.grand_total - self.credit_applied - self.refunded_amount


class SalesReturnLine(PricedLine):
    sales_return = models.ForeignKey(SalesReturn, on_delete=models.CASCADE, related_name="lines")
    invoice_line = models.ForeignKey(SalesInvoiceLine, on_delete=models.PROTECT, related_name="return_lines")
    inspection = models.CharField(max_length=10, choices=InspectionStatus.choices, default=InspectionStatus.RESTOCK)
    unit_cost = models.DecimalField(**RATE_DIGITS, default=0, help_text="Original cost restored to inventory")
    batch_number = models.CharField(max_length=60, blank=True)
    serial_numbers = models.JSONField(default=list, blank=True)

    class Meta:
        ordering = ["sales_return", "id"]
        constraints = [models.CheckConstraint(condition=Q(quantity__gt=0), name="sales_return_qty_positive")]
