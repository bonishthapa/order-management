from django.core.validators import MinValueValidator
from django.db import models

from apps.core.models import TimeStampedModel
from apps.core.money import PERCENT_DIGITS


class DateDisplayMode(models.TextChoices):
    AD = "AD", "AD only"
    BS = "BS", "BS only"
    AD_BS = "AD_BS", "AD + BS"


class DateInputCalendar(models.TextChoices):
    AD = "AD", "AD"
    BS = "BS", "BS"


class NegativeStockPolicy(models.TextChoices):
    DISALLOW = "DISALLOW", "Block postings that make stock negative"
    ALLOW = "ALLOW", "Allow negative stock (costed at last known cost)"


class Organization(TimeStampedModel):
    name = models.CharField(max_length=200)
    legal_name = models.CharField(max_length=200, blank=True)
    code = models.SlugField(max_length=30, unique=True)
    logo = models.ImageField(upload_to="logos/", blank=True, null=True)
    address = models.TextField(blank=True)
    city = models.CharField(max_length=100, blank=True)
    country = models.CharField(max_length=60, default="Nepal")
    email = models.EmailField(blank=True)
    phone = models.CharField(max_length=40, blank=True)
    website = models.CharField(max_length=200, blank=True)
    tax_id = models.CharField("PAN/VAT number", max_length=40, blank=True)
    currency = models.CharField(max_length=3, default="NPR")
    currency_symbol = models.CharField(max_length=8, default="Rs.")
    locale = models.CharField(max_length=10, default="en-NP")
    timezone = models.CharField(max_length=50, default="Asia/Kathmandu")
    date_display_mode = models.CharField(max_length=6, choices=DateDisplayMode.choices, default=DateDisplayMode.AD_BS)
    date_input_calendar = models.CharField(max_length=2, choices=DateInputCalendar.choices, default=DateInputCalendar.BS)
    negative_stock_policy = models.CharField(
        max_length=10, choices=NegativeStockPolicy.choices, default=NegativeStockPolicy.DISALLOW
    )
    allow_invoice_before_delivery = models.BooleanField(
        default=False, help_text="Allow invoicing sales order quantities that have not been delivered yet."
    )
    require_sales_order_approval = models.BooleanField(default=True)
    require_purchase_order_approval = models.BooleanField(default=True)
    require_expense_approval = models.BooleanField(default=True)
    terms_and_conditions = models.TextField(blank=True)
    document_footer = models.CharField(max_length=300, blank=True)
    is_active = models.BooleanField(default=True)

    def __str__(self):
        return self.name


class Branch(TimeStampedModel):
    organization = models.ForeignKey(Organization, on_delete=models.CASCADE, related_name="branches")
    code = models.CharField(max_length=10)
    name = models.CharField(max_length=120)
    address = models.TextField(blank=True)
    phone = models.CharField(max_length=40, blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["code"]
        constraints = [models.UniqueConstraint(fields=["organization", "code"], name="uniq_branch_code")]

    def __str__(self):
        return self.name


class ResetPolicy(models.TextChoices):
    FISCAL_YEAR = "FISCAL_YEAR", "Reset every fiscal year"
    CALENDAR_AD = "CALENDAR_AD", "Reset every AD calendar year"
    CALENDAR_BS = "CALENDAR_BS", "Reset every BS calendar year"
    CONTINUOUS = "CONTINUOUS", "Never reset"


class DocumentType(models.TextChoices):
    SALES_ORDER = "SO", "Sales order"
    DELIVERY = "DN", "Delivery note"
    SALES_INVOICE = "SI", "Sales invoice"
    CUSTOMER_RECEIPT = "RC", "Customer receipt"
    CUSTOMER_REFUND = "RF", "Customer refund"
    SALES_RETURN = "SR", "Sales return / credit note"
    PURCHASE_ORDER = "PO", "Purchase order"
    GOODS_RECEIPT = "GRN", "Goods received note"
    PURCHASE_BILL = "PB", "Supplier bill"
    PAYMENT_VOUCHER = "PV", "Payment voucher"
    PURCHASE_RETURN = "PR", "Purchase return / debit note"
    EXPENSE = "EX", "Expense voucher"
    JOURNAL = "JV", "Journal voucher"
    STOCK_MOVEMENT = "SM", "Stock movement"
    STOCK_TRANSFER = "ST", "Stock transfer"
    STOCK_COUNT = "SC", "Stock count"


class NumberingPolicy(TimeStampedModel):
    organization = models.ForeignKey(Organization, on_delete=models.CASCADE, related_name="numbering_policies")
    doc_type = models.CharField(max_length=20, choices=DocumentType.choices)
    prefix = models.CharField(max_length=12)
    separator = models.CharField(max_length=3, default="-", blank=True)
    reset_policy = models.CharField(max_length=12, choices=ResetPolicy.choices, default=ResetPolicy.FISCAL_YEAR)
    padding = models.PositiveSmallIntegerField(default=6, validators=[MinValueValidator(1)])
    include_branch = models.BooleanField(default=False)

    class Meta:
        ordering = ["doc_type"]
        constraints = [models.UniqueConstraint(fields=["organization", "doc_type"], name="uniq_numbering_policy")]


class TaxRate(TimeStampedModel):
    organization = models.ForeignKey(Organization, on_delete=models.CASCADE, related_name="tax_rates")
    name = models.CharField(max_length=60)
    rate = models.DecimalField(**PERCENT_DIGITS, validators=[MinValueValidator(0)])
    is_default = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["rate", "name"]
        constraints = [models.UniqueConstraint(fields=["organization", "name"], name="uniq_tax_rate_name")]

    def __str__(self):
        return f"{self.name} ({self.rate}%)"


class UnitOfMeasure(TimeStampedModel):
    organization = models.ForeignKey(Organization, on_delete=models.CASCADE, related_name="units")
    code = models.CharField(max_length=12)
    name = models.CharField(max_length=60)
    allow_fractions = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["code"]
        constraints = [models.UniqueConstraint(fields=["organization", "code"], name="uniq_uom_code")]

    def __str__(self):
        return self.code


class PaymentMethodKind(models.TextChoices):
    CASH = "CASH", "Cash"
    BANK = "BANK", "Bank transfer"
    CHEQUE = "CHEQUE", "Cheque"
    CARD = "CARD", "Card"
    WALLET = "WALLET", "Digital wallet"


class PaymentMethod(TimeStampedModel):
    organization = models.ForeignKey(Organization, on_delete=models.CASCADE, related_name="payment_methods")
    name = models.CharField(max_length=60)
    kind = models.CharField(max_length=10, choices=PaymentMethodKind.choices)
    default_account = models.ForeignKey(
        "accounting.Account", on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )
    requires_reference = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]
        constraints = [models.UniqueConstraint(fields=["organization", "name"], name="uniq_payment_method")]

    def __str__(self):
        return self.name
