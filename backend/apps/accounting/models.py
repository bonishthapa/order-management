from django.conf import settings
from django.db import models
from django.db.models import Q

from apps.core.models import OrganizationOwned, TimeStampedModel
from apps.core.money import MONEY_DIGITS


class AccountType(models.TextChoices):
    ASSET = "ASSET", "Asset"
    LIABILITY = "LIABILITY", "Liability"
    EQUITY = "EQUITY", "Equity"
    INCOME = "INCOME", "Income"
    EXPENSE = "EXPENSE", "Expense"


DEBIT_NORMAL = {AccountType.ASSET, AccountType.EXPENSE}


class SystemAccount(models.TextChoices):
    """Accounts the posting rules depend on. Each organisation has exactly one of each."""

    CASH = "CASH", "Cash in hand"
    BANK = "BANK", "Default bank account"
    RECEIVABLE = "RECEIVABLE", "Accounts receivable"
    INVENTORY = "INVENTORY", "Inventory"
    TAX_RECEIVABLE = "TAX_RECEIVABLE", "VAT receivable (input tax)"
    PAYABLE = "PAYABLE", "Accounts payable"
    GRNI = "GRNI", "Goods received not invoiced"
    TAX_PAYABLE = "TAX_PAYABLE", "VAT payable (output tax)"
    OPENING_EQUITY = "OPENING_EQUITY", "Opening balance equity"
    RETAINED_EARNINGS = "RETAINED_EARNINGS", "Retained earnings"
    SALES = "SALES", "Sales revenue"
    SALES_RETURNS = "SALES_RETURNS", "Sales returns and allowances"
    OTHER_INCOME = "OTHER_INCOME", "Freight and other charges income"
    COGS = "COGS", "Cost of goods sold"
    PURCHASE_VARIANCE = "PURCHASE_VARIANCE", "Purchase price variance"
    STOCK_ADJUSTMENT = "STOCK_ADJUSTMENT", "Inventory adjustments and write-offs"
    FREIGHT_IN = "FREIGHT_IN", "Freight inward and purchase charges"
    SERVICE_PURCHASES = "SERVICE_PURCHASES", "Purchases of non-stock items and services"


class Account(TimeStampedModel):
    organization = models.ForeignKey("organizations.Organization", on_delete=models.PROTECT, related_name="accounts")
    code = models.CharField(max_length=20)
    name = models.CharField(max_length=150)
    account_type = models.CharField(max_length=10, choices=AccountType.choices)
    parent = models.ForeignKey("self", on_delete=models.PROTECT, null=True, blank=True, related_name="children")
    system_key = models.CharField(max_length=20, choices=SystemAccount.choices, blank=True)
    is_group = models.BooleanField(default=False, help_text="Group accounts organise the chart and cannot be posted to.")
    is_cash = models.BooleanField(default=False)
    is_bank = models.BooleanField(default=False)
    bank_name = models.CharField(max_length=120, blank=True)
    bank_account_number = models.CharField(max_length=40, blank=True)
    bank_branch = models.CharField(max_length=120, blank=True)
    description = models.TextField(blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["code"]
        constraints = [
            models.UniqueConstraint(fields=["organization", "code"], name="uniq_account_code"),
            models.UniqueConstraint(
                fields=["organization", "system_key"], condition=~Q(system_key=""), name="uniq_system_account"
            ),
        ]

    def __str__(self):
        return f"{self.code} {self.name}"

    @property
    def is_debit_normal(self):
        return self.account_type in DEBIT_NORMAL

    @property
    def is_control(self):
        return self.system_key in (SystemAccount.RECEIVABLE, SystemAccount.PAYABLE, SystemAccount.INVENTORY)


class JournalStatus(models.TextChoices):
    DRAFT = "DRAFT", "Draft"
    POSTED = "POSTED", "Posted"
    REVERSED = "REVERSED", "Reversed"


class JournalSource(models.TextChoices):
    MANUAL = "MANUAL", "Manual journal"
    OPENING = "OPENING", "Opening balance"
    SALES_INVOICE = "SALES_INVOICE", "Sales invoice"
    DELIVERY = "DELIVERY", "Delivery (cost of goods sold)"
    CUSTOMER_RECEIPT = "CUSTOMER_RECEIPT", "Customer receipt"
    CUSTOMER_REFUND = "CUSTOMER_REFUND", "Customer refund"
    SALES_RETURN = "SALES_RETURN", "Sales return"
    GOODS_RECEIPT = "GOODS_RECEIPT", "Goods received"
    PURCHASE_BILL = "PURCHASE_BILL", "Supplier bill"
    PAYMENT_VOUCHER = "PAYMENT_VOUCHER", "Payment voucher"
    SUPPLIER_REFUND = "SUPPLIER_REFUND", "Supplier refund"
    PURCHASE_RETURN = "PURCHASE_RETURN", "Purchase return"
    EXPENSE = "EXPENSE", "Expense"
    STOCK = "STOCK", "Stock movement"
    YEAR_END = "YEAR_END", "Year-end closing"
    REVERSAL = "REVERSAL", "Reversal"


class JournalEntry(OrganizationOwned):
    number = models.CharField(max_length=40, blank=True)
    date = models.DateField()
    fiscal_year = models.ForeignKey("fiscal_years.FiscalYear", on_delete=models.PROTECT, related_name="journals")
    period = models.ForeignKey("fiscal_years.AccountingPeriod", on_delete=models.PROTECT, related_name="journals")
    narration = models.TextField(blank=True)
    source = models.CharField(max_length=20, choices=JournalSource.choices, default=JournalSource.MANUAL)
    source_id = models.PositiveBigIntegerField(null=True, blank=True)
    source_number = models.CharField(max_length=40, blank=True)
    idempotency_key = models.CharField(max_length=80, blank=True)
    status = models.CharField(max_length=10, choices=JournalStatus.choices, default=JournalStatus.DRAFT)
    posted_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    posted_at = models.DateTimeField(null=True, blank=True)
    reversal_of = models.OneToOneField(
        "self", on_delete=models.PROTECT, null=True, blank=True, related_name="reversed_by"
    )
    reversal_reason = models.TextField(blank=True)
    total_debit = models.DecimalField(**MONEY_DIGITS, default=0)
    total_credit = models.DecimalField(**MONEY_DIGITS, default=0)

    class Meta:
        ordering = ["-date", "-id"]
        verbose_name_plural = "journal entries"
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "number"], condition=~Q(number=""), name="uniq_journal_number"
            ),
            models.UniqueConstraint(
                fields=["organization", "idempotency_key"], condition=~Q(idempotency_key=""), name="uniq_journal_idempotency"
            ),
            models.CheckConstraint(
                condition=~Q(status="POSTED") | Q(total_debit=models.F("total_credit")), name="posted_journal_balanced"
            ),
        ]
        indexes = [
            models.Index(fields=["organization", "date"]),
            models.Index(fields=["organization", "source", "source_id"]),
        ]

    def __str__(self):
        return self.number or f"Draft journal #{self.pk}"


class JournalLine(models.Model):
    entry = models.ForeignKey(JournalEntry, on_delete=models.CASCADE, related_name="lines")
    line_no = models.PositiveSmallIntegerField(default=1)
    account = models.ForeignKey(Account, on_delete=models.PROTECT, related_name="lines")
    debit = models.DecimalField(**MONEY_DIGITS, default=0)
    credit = models.DecimalField(**MONEY_DIGITS, default=0)
    description = models.CharField(max_length=255, blank=True)
    customer = models.ForeignKey("customers.Customer", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    supplier = models.ForeignKey("suppliers.Supplier", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    cleared_date = models.DateField(null=True, blank=True, help_text="Bank reconciliation clearing date")
    reconciliation = models.ForeignKey(
        "BankReconciliation", on_delete=models.SET_NULL, null=True, blank=True, related_name="lines"
    )

    class Meta:
        ordering = ["entry", "line_no"]
        constraints = [
            models.CheckConstraint(condition=Q(debit__gte=0) & Q(credit__gte=0), name="journal_line_non_negative"),
            models.CheckConstraint(
                condition=(Q(debit=0) & Q(credit__gt=0)) | (Q(credit=0) & Q(debit__gt=0)),
                name="journal_line_one_side",
            ),
        ]
        indexes = [
            models.Index(fields=["account", "entry"]),
            models.Index(fields=["customer"]),
            models.Index(fields=["supplier"]),
        ]


class BankReconciliation(OrganizationOwned):
    account = models.ForeignKey(Account, on_delete=models.PROTECT, related_name="reconciliations")
    statement_date = models.DateField()
    statement_balance = models.DecimalField(**MONEY_DIGITS)
    book_balance = models.DecimalField(**MONEY_DIGITS)
    cleared_balance = models.DecimalField(**MONEY_DIGITS)
    difference = models.DecimalField(**MONEY_DIGITS)
    notes = models.TextField(blank=True)

    class Meta:
        ordering = ["-statement_date", "-id"]
