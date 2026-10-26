"""Bootstrap a new organisation with the master data the posting rules require."""
from decimal import Decimal

from django.db import transaction

from apps.accounting.models import Account, AccountType, SystemAccount
from apps.core.numbering import DEFAULT_PREFIXES

from .models import DocumentType, NumberingPolicy, PaymentMethod, PaymentMethodKind, TaxRate, UnitOfMeasure

A, L, E, I, X = AccountType.ASSET, AccountType.LIABILITY, AccountType.EQUITY, AccountType.INCOME, AccountType.EXPENSE

# (code, name, type, parent code, system key, flags)
DEFAULT_CHART = [
    ("1000", "Assets", A, None, "", {"is_group": True}),
    ("1100", "Cash in hand", A, "1000", SystemAccount.CASH, {"is_cash": True}),
    ("1110", "Petty cash", A, "1000", "", {"is_cash": True}),
    ("1200", "Bank – current account", A, "1000", SystemAccount.BANK, {"is_bank": True}),
    ("1300", "Accounts receivable", A, "1000", SystemAccount.RECEIVABLE, {}),
    ("1400", "Inventory", A, "1000", SystemAccount.INVENTORY, {}),
    ("1500", "VAT receivable (input tax)", A, "1000", SystemAccount.TAX_RECEIVABLE, {}),
    ("1600", "Advances and prepayments", A, "1000", "", {}),
    ("1700", "Fixed assets", A, "1000", "", {}),
    ("2000", "Liabilities", L, None, "", {"is_group": True}),
    ("2100", "Accounts payable", L, "2000", SystemAccount.PAYABLE, {}),
    ("2150", "Goods received not invoiced", L, "2000", SystemAccount.GRNI, {}),
    ("2200", "VAT payable (output tax)", L, "2000", SystemAccount.TAX_PAYABLE, {}),
    ("2300", "Accrued expenses", L, "2000", "", {}),
    ("2400", "Loans", L, "2000", "", {}),
    ("3000", "Equity", E, None, "", {"is_group": True}),
    ("3100", "Owner's capital", E, "3000", "", {}),
    ("3200", "Retained earnings", E, "3000", SystemAccount.RETAINED_EARNINGS, {}),
    ("3300", "Opening balance equity", E, "3000", SystemAccount.OPENING_EQUITY, {}),
    ("4000", "Income", I, None, "", {"is_group": True}),
    ("4100", "Sales revenue", I, "4000", SystemAccount.SALES, {}),
    ("4150", "Sales returns and allowances", I, "4000", SystemAccount.SALES_RETURNS, {}),
    ("4200", "Freight and other charges income", I, "4000", SystemAccount.OTHER_INCOME, {}),
    ("4300", "Other income", I, "4000", "", {}),
    ("5000", "Cost of sales", X, None, "", {"is_group": True}),
    ("5100", "Cost of goods sold", X, "5000", SystemAccount.COGS, {}),
    ("5200", "Purchase price variance", X, "5000", SystemAccount.PURCHASE_VARIANCE, {}),
    ("5300", "Inventory adjustments and write-offs", X, "5000", SystemAccount.STOCK_ADJUSTMENT, {}),
    ("5400", "Freight inward", X, "5000", SystemAccount.FREIGHT_IN, {}),
    ("5500", "Purchases – services and non-stock", X, "5000", SystemAccount.SERVICE_PURCHASES, {}),
    ("6000", "Operating expenses", X, None, "", {"is_group": True}),
    ("6100", "Rent", X, "6000", "", {}),
    ("6200", "Salaries and wages", X, "6000", "", {}),
    ("6300", "Utilities", X, "6000", "", {}),
    ("6400", "Office supplies", X, "6000", "", {}),
    ("6500", "Transport and delivery", X, "6000", "", {}),
    ("6600", "Repairs and maintenance", X, "6000", "", {}),
    ("6700", "Bank charges", X, "6000", "", {}),
    ("6800", "Communication", X, "6000", "", {}),
    ("6900", "Miscellaneous expenses", X, "6000", "", {}),
]

DEFAULT_EXPENSE_CATEGORIES = [
    ("Rent", "6100"), ("Salaries and wages", "6200"), ("Utilities", "6300"), ("Office supplies", "6400"),
    ("Transport and delivery", "6500"), ("Repairs and maintenance", "6600"), ("Bank charges", "6700"),
    ("Communication", "6800"), ("Miscellaneous", "6900"),
]

DEFAULT_UNITS = [
    ("PCS", "Pieces", False), ("BOX", "Box", False), ("CTN", "Carton", False), ("SET", "Set", False),
    ("KG", "Kilogram", True), ("LTR", "Litre", True), ("MTR", "Metre", True), ("HR", "Hour", True),
]


@transaction.atomic
def bootstrap_organization(organization):
    from apps.expenses.models import ExpenseCategory
    from apps.inventory.models import Warehouse

    accounts = {}
    for code, name, account_type, parent, key, flags in DEFAULT_CHART:
        accounts[code], _ = Account.objects.get_or_create(
            organization=organization,
            code=code,
            defaults={"name": name, "account_type": account_type, "parent": accounts.get(parent),
                      "system_key": key, **flags},
        )
    TaxRate.objects.get_or_create(organization=organization, name="VAT 13%", defaults={"rate": Decimal("13"), "is_default": True})
    TaxRate.objects.get_or_create(organization=organization, name="Exempt", defaults={"rate": Decimal("0")})
    for code, name, fractions in DEFAULT_UNITS:
        UnitOfMeasure.objects.get_or_create(organization=organization, code=code, defaults={"name": name, "allow_fractions": fractions})
    for name, kind, account_code, needs_ref in [
        ("Cash", PaymentMethodKind.CASH, "1100", False),
        ("Bank transfer", PaymentMethodKind.BANK, "1200", True),
        ("Cheque", PaymentMethodKind.CHEQUE, "1200", True),
        ("Digital wallet", PaymentMethodKind.WALLET, "1200", True),
    ]:
        PaymentMethod.objects.get_or_create(
            organization=organization, name=name,
            defaults={"kind": kind, "default_account": accounts[account_code], "requires_reference": needs_ref},
        )
    for doc_type in DocumentType.values:
        NumberingPolicy.objects.get_or_create(
            organization=organization, doc_type=doc_type, defaults={"prefix": DEFAULT_PREFIXES.get(doc_type, doc_type)}
        )
    for name, code in DEFAULT_EXPENSE_CATEGORIES:
        ExpenseCategory.objects.get_or_create(organization=organization, name=name, defaults={"account": accounts[code]})
    Warehouse.objects.get_or_create(
        organization=organization, is_transit=True, defaults={"code": "TRANSIT", "name": "Goods in transit"}
    )
    return organization
