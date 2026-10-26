from django.conf import settings
from django.core.validators import MinValueValidator
from django.db import models
from django.db.models import Q

from apps.core.models import OrganizationOwned, TimeStampedModel
from apps.core.money import MONEY_DIGITS, PERCENT_DIGITS


class ExpenseCategory(TimeStampedModel):
    organization = models.ForeignKey("organizations.Organization", on_delete=models.CASCADE, related_name="+")
    name = models.CharField(max_length=100)
    account = models.ForeignKey("accounting.Account", on_delete=models.PROTECT, related_name="+")
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]
        verbose_name_plural = "expense categories"
        constraints = [models.UniqueConstraint(fields=["organization", "name"], name="uniq_expense_category")]

    def __str__(self):
        return self.name


class ExpenseStatus(models.TextChoices):
    DRAFT = "DRAFT", "Draft"
    SUBMITTED = "SUBMITTED", "Awaiting approval"
    POSTED = "POSTED", "Approved and posted"
    REJECTED = "REJECTED", "Rejected"
    REVERSED = "REVERSED", "Reversed"


class Expense(OrganizationOwned):
    number = models.CharField(max_length=40, blank=True)
    fiscal_year = models.ForeignKey("fiscal_years.FiscalYear", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    category = models.ForeignKey(ExpenseCategory, on_delete=models.PROTECT, related_name="expenses")
    date = models.DateField()
    payee = models.CharField(max_length=200)
    supplier = models.ForeignKey("suppliers.Supplier", on_delete=models.PROTECT, null=True, blank=True, related_name="expenses")
    amount = models.DecimalField(**MONEY_DIGITS, validators=[MinValueValidator(0)], help_text="Amount before tax")
    tax_rate = models.ForeignKey("organizations.TaxRate", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    tax_percent = models.DecimalField(**PERCENT_DIGITS, default=0)
    tax_amount = models.DecimalField(**MONEY_DIGITS, default=0)
    total = models.DecimalField(**MONEY_DIGITS, default=0)
    payment_method = models.ForeignKey("organizations.PaymentMethod", on_delete=models.PROTECT, related_name="+")
    paid_from_account = models.ForeignKey("accounting.Account", on_delete=models.PROTECT, related_name="+")
    reference = models.CharField(max_length=80, blank=True)
    description = models.TextField(blank=True)
    status = models.CharField(max_length=10, choices=ExpenseStatus.choices, default=ExpenseStatus.DRAFT)
    submitted_at = models.DateTimeField(null=True, blank=True)
    approved_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    approved_at = models.DateTimeField(null=True, blank=True)
    rejection_reason = models.TextField(blank=True)
    reversal_reason = models.TextField(blank=True)
    journal = models.ForeignKey("accounting.JournalEntry", on_delete=models.PROTECT, null=True, blank=True, related_name="+")

    class Meta:
        ordering = ["-date", "-id"]
        constraints = [
            models.UniqueConstraint(fields=["organization", "number"], condition=~Q(number=""), name="uniq_expense_number"),
            models.CheckConstraint(condition=Q(amount__gt=0), name="expense_amount_positive"),
        ]
        indexes = [models.Index(fields=["organization", "date"])]

    def __str__(self):
        return self.number or f"Draft expense #{self.pk}"
