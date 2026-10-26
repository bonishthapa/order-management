"""Shared fields and the single, server-side pricing calculation used by every trade document.

Per line (each step rounded to 2 decimals, half-up):
    gross    = quantity × unit_price
    discount = gross × discount_percent / 100
    taxable  = gross − discount
    tax      = taxable × tax_percent / 100
    total    = taxable + tax
Document: subtotal = Σ gross, discount_total = Σ discount, taxable_total = Σ taxable,
tax_total = Σ tax, grand_total = taxable_total + tax_total + freight + other_charges.
Freight and other charges are not taxed.
"""
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models

from .money import MONEY_DIGITS, PERCENT_DIGITS, QTY_DIGITS, RATE_DIGITS, ZERO, money


class PricedLine(models.Model):
    product = models.ForeignKey("products.Product", on_delete=models.PROTECT, related_name="+")
    description = models.CharField(max_length=255, blank=True)
    quantity = models.DecimalField(**QTY_DIGITS, validators=[MinValueValidator(0)])
    unit_price = models.DecimalField(**RATE_DIGITS, validators=[MinValueValidator(0)])
    discount_percent = models.DecimalField(
        **PERCENT_DIGITS, default=0, validators=[MinValueValidator(0), MaxValueValidator(100)]
    )
    tax_rate = models.ForeignKey("organizations.TaxRate", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    tax_percent = models.DecimalField(**PERCENT_DIGITS, default=0)
    gross_amount = models.DecimalField(**MONEY_DIGITS, default=0)
    discount_amount = models.DecimalField(**MONEY_DIGITS, default=0)
    taxable_amount = models.DecimalField(**MONEY_DIGITS, default=0)
    tax_amount = models.DecimalField(**MONEY_DIGITS, default=0)
    line_total = models.DecimalField(**MONEY_DIGITS, default=0)

    class Meta:
        abstract = True

    def compute(self):
        self.tax_percent = self.tax_rate.rate if self.tax_rate_id else ZERO
        self.gross_amount = money(self.quantity * self.unit_price)
        self.discount_amount = money(self.gross_amount * self.discount_percent / 100)
        self.taxable_amount = self.gross_amount - self.discount_amount
        self.tax_amount = money(self.taxable_amount * self.tax_percent / 100)
        self.line_total = self.taxable_amount + self.tax_amount
        return self

    @property
    def net_unit_price(self):
        """Unit price after discount, before tax (used for inventory and revenue per unit)."""
        if not self.quantity:
            return ZERO
        return self.taxable_amount / self.quantity


class PricedDocument(models.Model):
    subtotal = models.DecimalField(**MONEY_DIGITS, default=0)
    discount_total = models.DecimalField(**MONEY_DIGITS, default=0)
    taxable_total = models.DecimalField(**MONEY_DIGITS, default=0)
    tax_total = models.DecimalField(**MONEY_DIGITS, default=0)
    freight = models.DecimalField(**MONEY_DIGITS, default=0, validators=[MinValueValidator(0)])
    other_charges = models.DecimalField(**MONEY_DIGITS, default=0, validators=[MinValueValidator(0)])
    grand_total = models.DecimalField(**MONEY_DIGITS, default=0)

    class Meta:
        abstract = True

    def recalculate(self, lines=None):
        lines = list(lines if lines is not None else self.lines.all())
        for line in lines:
            line.compute()
        self.subtotal = sum((line.gross_amount for line in lines), ZERO)
        self.discount_total = sum((line.discount_amount for line in lines), ZERO)
        self.taxable_total = sum((line.taxable_amount for line in lines), ZERO)
        self.tax_total = sum((line.tax_amount for line in lines), ZERO)
        self.grand_total = self.taxable_total + self.tax_total + money(self.freight) + money(self.other_charges)
        return lines

    def tax_breakdown(self):
        """[{"rate": Decimal, "taxable": Decimal, "tax": Decimal}] grouped by tax percentage."""
        groups = {}
        for line in self.lines.all():
            bucket = groups.setdefault(line.tax_percent, {"rate": line.tax_percent, "taxable": ZERO, "tax": ZERO})
            bucket["taxable"] += line.taxable_amount
            bucket["tax"] += line.tax_amount
        return [groups[key] for key in sorted(groups)]
