"""Customer receipts, supplier payment vouchers, refunds and their allocations.

An allocation matches money (a receipt / voucher) or a credit (sales or purchase return) to an
open invoice or bill. Invoice ``amount_paid``/``amount_credited`` are recomputed from active
allocations by ``apps.payments.services`` inside the posting transaction; clients never send them.
"""
from django.conf import settings
from django.db import models
from django.db.models import Q

from apps.core.models import OrganizationOwned
from apps.core.money import MONEY_DIGITS


class PaymentDocStatus(models.TextChoices):
    DRAFT = "DRAFT", "Draft"
    POSTED = "POSTED", "Posted"
    REVERSED = "REVERSED", "Reversed"
    CANCELLED = "CANCELLED", "Cancelled"


class CustomerReceipt(OrganizationOwned):
    number = models.CharField(max_length=40, blank=True)
    fiscal_year = models.ForeignKey("fiscal_years.FiscalYear", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    customer = models.ForeignKey("customers.Customer", on_delete=models.PROTECT, related_name="receipts")
    date = models.DateField()
    amount = models.DecimalField(**MONEY_DIGITS)
    payment_method = models.ForeignKey("organizations.PaymentMethod", on_delete=models.PROTECT, related_name="+")
    deposit_account = models.ForeignKey("accounting.Account", on_delete=models.PROTECT, related_name="+")
    reference = models.CharField(max_length=80, blank=True)
    notes = models.TextField(blank=True)
    status = models.CharField(max_length=10, choices=PaymentDocStatus.choices, default=PaymentDocStatus.POSTED)
    allocated_amount = models.DecimalField(**MONEY_DIGITS, default=0)
    refunded_amount = models.DecimalField(**MONEY_DIGITS, default=0)
    received_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, related_name="+")
    journal = models.ForeignKey("accounting.JournalEntry", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    reversal_reason = models.TextField(blank=True)
    reversed_at = models.DateTimeField(null=True, blank=True)
    print_count = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["-date", "-id"]
        constraints = [
            models.UniqueConstraint(fields=["organization", "number"], condition=~Q(number=""), name="uniq_receipt_number"),
            models.CheckConstraint(condition=Q(amount__gt=0), name="receipt_amount_positive"),
            models.CheckConstraint(
                condition=Q(allocated_amount__gte=0) & Q(refunded_amount__gte=0)
                & Q(amount__gte=models.F("allocated_amount") + models.F("refunded_amount")),
                name="receipt_not_over_allocated",
            ),
        ]

    def __str__(self):
        return self.number

    @property
    def unapplied_amount(self):
        return self.amount - self.allocated_amount - self.refunded_amount


class InvoiceAllocation(models.Model):
    """Applies a receipt or a sales-return credit to an invoice."""

    organization = models.ForeignKey("organizations.Organization", on_delete=models.PROTECT, related_name="+")
    invoice = models.ForeignKey("sales.SalesInvoice", on_delete=models.PROTECT, related_name="allocations")
    receipt = models.ForeignKey(CustomerReceipt, on_delete=models.PROTECT, null=True, blank=True, related_name="allocations")
    credit_note = models.ForeignKey("sales.SalesReturn", on_delete=models.PROTECT, null=True, blank=True, related_name="allocations")
    amount = models.DecimalField(**MONEY_DIGITS)
    date = models.DateField()
    is_active = models.BooleanField(default=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    reversed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["date", "id"]
        constraints = [
            models.CheckConstraint(condition=Q(amount__gt=0), name="invoice_allocation_positive"),
            models.CheckConstraint(
                condition=(Q(receipt__isnull=False) & Q(credit_note__isnull=True))
                | (Q(receipt__isnull=True) & Q(credit_note__isnull=False)),
                name="invoice_allocation_one_source",
            ),
        ]


class CustomerRefund(OrganizationOwned):
    """Money paid back to a customer out of an unapplied receipt or credit note."""

    number = models.CharField(max_length=40, blank=True)
    customer = models.ForeignKey("customers.Customer", on_delete=models.PROTECT, related_name="refunds")
    date = models.DateField()
    amount = models.DecimalField(**MONEY_DIGITS)
    receipt = models.ForeignKey(CustomerReceipt, on_delete=models.PROTECT, null=True, blank=True, related_name="refunds")
    credit_note = models.ForeignKey("sales.SalesReturn", on_delete=models.PROTECT, null=True, blank=True, related_name="refunds")
    payment_method = models.ForeignKey("organizations.PaymentMethod", on_delete=models.PROTECT, related_name="+")
    paid_from_account = models.ForeignKey("accounting.Account", on_delete=models.PROTECT, related_name="+")
    reference = models.CharField(max_length=80, blank=True)
    notes = models.TextField(blank=True)
    status = models.CharField(max_length=10, choices=PaymentDocStatus.choices, default=PaymentDocStatus.POSTED)
    journal = models.ForeignKey("accounting.JournalEntry", on_delete=models.PROTECT, null=True, blank=True, related_name="+")

    class Meta:
        ordering = ["-date", "-id"]
        constraints = [
            models.UniqueConstraint(fields=["organization", "number"], condition=~Q(number=""), name="uniq_customer_refund_number"),
            models.CheckConstraint(condition=Q(amount__gt=0), name="customer_refund_positive"),
            models.CheckConstraint(
                condition=(Q(receipt__isnull=False) & Q(credit_note__isnull=True))
                | (Q(receipt__isnull=True) & Q(credit_note__isnull=False)),
                name="customer_refund_one_source",
            ),
        ]


class PaymentVoucher(OrganizationOwned):
    number = models.CharField(max_length=40, blank=True)
    fiscal_year = models.ForeignKey("fiscal_years.FiscalYear", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    supplier = models.ForeignKey("suppliers.Supplier", on_delete=models.PROTECT, related_name="payments")
    date = models.DateField()
    amount = models.DecimalField(**MONEY_DIGITS)
    payment_method = models.ForeignKey("organizations.PaymentMethod", on_delete=models.PROTECT, related_name="+")
    paid_from_account = models.ForeignKey("accounting.Account", on_delete=models.PROTECT, related_name="+")
    reference = models.CharField(max_length=80, blank=True)
    notes = models.TextField(blank=True)
    status = models.CharField(max_length=10, choices=PaymentDocStatus.choices, default=PaymentDocStatus.DRAFT)
    allocated_amount = models.DecimalField(**MONEY_DIGITS, default=0)
    refunded_amount = models.DecimalField(**MONEY_DIGITS, default=0)
    requested_allocations = models.JSONField(
        default=list, blank=True, help_text="Draft allocations [{bill, amount}] applied when the voucher is posted"
    )
    prepared_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, related_name="+")
    approved_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    approved_at = models.DateTimeField(null=True, blank=True)
    journal = models.ForeignKey("accounting.JournalEntry", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    reversal_reason = models.TextField(blank=True)
    reversed_at = models.DateTimeField(null=True, blank=True)
    print_count = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["-date", "-id"]
        constraints = [
            models.UniqueConstraint(fields=["organization", "number"], condition=~Q(number=""), name="uniq_voucher_number"),
            models.CheckConstraint(condition=Q(amount__gt=0), name="voucher_amount_positive"),
            models.CheckConstraint(
                condition=Q(allocated_amount__gte=0) & Q(refunded_amount__gte=0)
                & Q(amount__gte=models.F("allocated_amount") + models.F("refunded_amount")),
                name="voucher_not_over_allocated",
            ),
        ]

    def __str__(self):
        return self.number or f"Draft voucher #{self.pk}"

    @property
    def unapplied_amount(self):
        return self.amount - self.allocated_amount - self.refunded_amount


class BillAllocation(models.Model):
    organization = models.ForeignKey("organizations.Organization", on_delete=models.PROTECT, related_name="+")
    bill = models.ForeignKey("purchases.SupplierBill", on_delete=models.PROTECT, related_name="allocations")
    voucher = models.ForeignKey(PaymentVoucher, on_delete=models.PROTECT, null=True, blank=True, related_name="allocations")
    debit_note = models.ForeignKey("purchases.PurchaseReturn", on_delete=models.PROTECT, null=True, blank=True, related_name="allocations")
    amount = models.DecimalField(**MONEY_DIGITS)
    date = models.DateField()
    is_active = models.BooleanField(default=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    reversed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["date", "id"]
        constraints = [
            models.CheckConstraint(condition=Q(amount__gt=0), name="bill_allocation_positive"),
            models.CheckConstraint(
                condition=(Q(voucher__isnull=False) & Q(debit_note__isnull=True))
                | (Q(voucher__isnull=True) & Q(debit_note__isnull=False)),
                name="bill_allocation_one_source",
            ),
        ]


class SupplierRefund(OrganizationOwned):
    """Money received back from a supplier against an unapplied voucher or debit note."""

    number = models.CharField(max_length=40, blank=True)
    supplier = models.ForeignKey("suppliers.Supplier", on_delete=models.PROTECT, related_name="refunds")
    date = models.DateField()
    amount = models.DecimalField(**MONEY_DIGITS)
    voucher = models.ForeignKey(PaymentVoucher, on_delete=models.PROTECT, null=True, blank=True, related_name="refunds")
    debit_note = models.ForeignKey("purchases.PurchaseReturn", on_delete=models.PROTECT, null=True, blank=True, related_name="refunds")
    payment_method = models.ForeignKey("organizations.PaymentMethod", on_delete=models.PROTECT, related_name="+")
    deposit_account = models.ForeignKey("accounting.Account", on_delete=models.PROTECT, related_name="+")
    reference = models.CharField(max_length=80, blank=True)
    notes = models.TextField(blank=True)
    status = models.CharField(max_length=10, choices=PaymentDocStatus.choices, default=PaymentDocStatus.POSTED)
    journal = models.ForeignKey("accounting.JournalEntry", on_delete=models.PROTECT, null=True, blank=True, related_name="+")

    class Meta:
        ordering = ["-date", "-id"]
        constraints = [
            models.UniqueConstraint(fields=["organization", "number"], condition=~Q(number=""), name="uniq_supplier_refund_number"),
            models.CheckConstraint(condition=Q(amount__gt=0), name="supplier_refund_positive"),
        ]
