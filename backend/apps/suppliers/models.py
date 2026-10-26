from django.db import models

from apps.core.models import OrganizationOwned, TimeStampedModel
from apps.core.money import MONEY_DIGITS


class SupplierCategory(TimeStampedModel):
    organization = models.ForeignKey("organizations.Organization", on_delete=models.CASCADE, related_name="+")
    name = models.CharField(max_length=80)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]
        verbose_name_plural = "supplier categories"
        constraints = [models.UniqueConstraint(fields=["organization", "name"], name="uniq_supplier_category")]

    def __str__(self):
        return self.name


class Supplier(OrganizationOwned):
    code = models.CharField(max_length=20)
    name = models.CharField("company name", max_length=200)
    contact_person = models.CharField(max_length=120, blank=True)
    phone = models.CharField(max_length=40, blank=True)
    email = models.EmailField(blank=True)
    address = models.TextField(blank=True)
    tax_id = models.CharField("PAN/VAT", max_length=40, blank=True)
    payment_terms_days = models.PositiveSmallIntegerField(default=30)
    category = models.ForeignKey(SupplierCategory, on_delete=models.PROTECT, null=True, blank=True, related_name="suppliers")
    bank_name = models.CharField(max_length=120, blank=True)
    bank_account_name = models.CharField(max_length=120, blank=True)
    bank_account_number = models.CharField(max_length=40, blank=True)
    bank_branch = models.CharField(max_length=120, blank=True)
    notes = models.TextField(blank=True)
    is_active = models.BooleanField(default=True)
    opening_balance = models.DecimalField(
        **MONEY_DIGITS, default=0, help_text="Positive = we owe the supplier; negative = advance paid."
    )
    opening_balance_date = models.DateField(null=True, blank=True)
    opening_balance_journal = models.ForeignKey(
        "accounting.JournalEntry", on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )

    class Meta:
        ordering = ["name"]
        constraints = [models.UniqueConstraint(fields=["organization", "code"], name="uniq_supplier_code")]
        indexes = [models.Index(fields=["organization", "name"])]

    def __str__(self):
        return self.name
