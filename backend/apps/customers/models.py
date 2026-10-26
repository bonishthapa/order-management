from django.core.validators import MinValueValidator
from django.db import models

from apps.core.models import OrganizationOwned, TimeStampedModel
from apps.core.money import MONEY_DIGITS


class CustomerCategory(TimeStampedModel):
    organization = models.ForeignKey("organizations.Organization", on_delete=models.CASCADE, related_name="+")
    name = models.CharField(max_length=80)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]
        verbose_name_plural = "customer categories"
        constraints = [models.UniqueConstraint(fields=["organization", "name"], name="uniq_customer_category")]

    def __str__(self):
        return self.name


class Customer(OrganizationOwned):
    code = models.CharField(max_length=20)
    name = models.CharField("company name", max_length=200)
    contact_person = models.CharField(max_length=120, blank=True)
    phone = models.CharField(max_length=40, blank=True)
    email = models.EmailField(blank=True)
    billing_address = models.TextField(blank=True)
    shipping_address = models.TextField(blank=True)
    tax_id = models.CharField("PAN/VAT", max_length=40, blank=True)
    credit_limit = models.DecimalField(**MONEY_DIGITS, default=0, validators=[MinValueValidator(0)])
    payment_terms_days = models.PositiveSmallIntegerField(default=30)
    category = models.ForeignKey(CustomerCategory, on_delete=models.PROTECT, null=True, blank=True, related_name="customers")
    notes = models.TextField(blank=True)
    is_active = models.BooleanField(default=True)
    opening_balance = models.DecimalField(
        **MONEY_DIGITS, default=0, help_text="Positive = customer owes us; negative = advance held."
    )
    opening_balance_date = models.DateField(null=True, blank=True)
    opening_balance_journal = models.ForeignKey(
        "accounting.JournalEntry", on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )

    class Meta:
        ordering = ["name"]
        constraints = [models.UniqueConstraint(fields=["organization", "code"], name="uniq_customer_code")]
        indexes = [models.Index(fields=["organization", "name"])]

    def __str__(self):
        return self.name
