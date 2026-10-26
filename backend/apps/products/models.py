from django.core.validators import MinValueValidator
from django.db import models
from django.db.models import Q

from apps.core.models import OrganizationOwned, TimeStampedModel
from apps.core.money import QTY_DIGITS, RATE_DIGITS


class ProductCategory(TimeStampedModel):
    organization = models.ForeignKey("organizations.Organization", on_delete=models.CASCADE, related_name="+")
    name = models.CharField(max_length=100)
    parent = models.ForeignKey("self", on_delete=models.PROTECT, null=True, blank=True, related_name="children")
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]
        verbose_name_plural = "product categories"
        constraints = [models.UniqueConstraint(fields=["organization", "name"], name="uniq_product_category")]

    def __str__(self):
        return self.name


class Brand(TimeStampedModel):
    organization = models.ForeignKey("organizations.Organization", on_delete=models.CASCADE, related_name="+")
    name = models.CharField(max_length=100)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]
        constraints = [models.UniqueConstraint(fields=["organization", "name"], name="uniq_brand")]

    def __str__(self):
        return self.name


class ProductType(models.TextChoices):
    STOCK = "STOCK", "Stock item"
    SERVICE = "SERVICE", "Service / non-stock"


class Product(OrganizationOwned):
    sku = models.CharField(max_length=40)
    barcode = models.CharField(max_length=60, blank=True)
    name = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    product_type = models.CharField(max_length=8, choices=ProductType.choices, default=ProductType.STOCK)
    category = models.ForeignKey(ProductCategory, on_delete=models.PROTECT, null=True, blank=True, related_name="products")
    brand = models.ForeignKey(Brand, on_delete=models.PROTECT, null=True, blank=True, related_name="products")
    unit = models.ForeignKey("organizations.UnitOfMeasure", on_delete=models.PROTECT, related_name="products")
    purchase_price = models.DecimalField(**RATE_DIGITS, default=0, validators=[MinValueValidator(0)])
    selling_price = models.DecimalField(**RATE_DIGITS, default=0, validators=[MinValueValidator(0)])
    tax_rate = models.ForeignKey("organizations.TaxRate", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    reorder_level = models.DecimalField(**QTY_DIGITS, default=0, validators=[MinValueValidator(0)])
    reorder_quantity = models.DecimalField(**QTY_DIGITS, default=0, validators=[MinValueValidator(0)])
    image = models.ImageField(upload_to="products/", blank=True, null=True)
    track_batches = models.BooleanField(default=False)
    track_serials = models.BooleanField(default=False)
    track_expiry = models.BooleanField(default=False)
    variant_of = models.ForeignKey("self", on_delete=models.PROTECT, null=True, blank=True, related_name="variants")
    variant_attributes = models.JSONField(default=dict, blank=True, help_text='e.g. {"Size": "L", "Colour": "Blue"}')
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(fields=["organization", "sku"], name="uniq_product_sku"),
            models.UniqueConstraint(
                fields=["organization", "barcode"], condition=~Q(barcode=""), name="uniq_product_barcode"
            ),
            models.CheckConstraint(
                condition=Q(product_type="STOCK") | (Q(track_batches=False) & Q(track_serials=False)),
                name="service_not_tracked",
            ),
        ]
        indexes = [models.Index(fields=["organization", "name"])]

    def __str__(self):
        return f"{self.sku} {self.name}"

    @property
    def is_stock(self):
        return self.product_type == ProductType.STOCK


class PriceTier(TimeStampedModel):
    """Wholesale price that applies from ``min_quantity`` upwards (optionally per customer category)."""

    product = models.ForeignKey(Product, on_delete=models.CASCADE, related_name="price_tiers")
    customer_category = models.ForeignKey(
        "customers.CustomerCategory", on_delete=models.CASCADE, null=True, blank=True, related_name="+"
    )
    min_quantity = models.DecimalField(**QTY_DIGITS, validators=[MinValueValidator(0)])
    price = models.DecimalField(**RATE_DIGITS, validators=[MinValueValidator(0)])

    class Meta:
        ordering = ["product", "min_quantity"]
        constraints = [
            models.UniqueConstraint(
                fields=["product", "customer_category", "min_quantity"],
                name="uniq_price_tier",
                nulls_distinct=False,
            )
        ]
