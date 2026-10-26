"""Role-based permission matrix. Enforced on the server by apps.core.permissions.

Permissions are ``<module>.<action>`` strings. A role grants a fixed set; the frontend receives
the effective set for navigation, but every API call is re-checked here.
"""
from django.db import models


class Role(models.TextChoices):
    SUPER_ADMIN = "SUPER_ADMIN", "Super Admin"
    COMPANY_ADMIN = "COMPANY_ADMIN", "Company Admin"
    MANAGER = "MANAGER", "Manager"
    SALES = "SALES", "Sales Staff"
    PURCHASE = "PURCHASE", "Purchase Staff"
    WAREHOUSE = "WAREHOUSE", "Warehouse Staff"
    ACCOUNTANT = "ACCOUNTANT", "Accountant"
    AUDITOR = "AUDITOR", "Read-only Auditor"


ALL_PERMISSIONS = {
    "dashboard.view": "View dashboard",
    "settings.view": "View company settings",
    "settings.manage": "Change company settings, numbering, taxes and master lists",
    "users.manage": "Manage users and roles",
    "fiscal.view": "View fiscal years and periods",
    "fiscal.manage": "Create fiscal years, lock periods",
    "fiscal.close": "Run year-end closing",
    "fiscal.reopen": "Reopen closed periods or fiscal years",
    "customers.view": "View customers",
    "customers.manage": "Create and edit customers",
    "suppliers.view": "View suppliers",
    "suppliers.manage": "Create and edit suppliers",
    "suppliers.bank_view": "View supplier bank details",
    "products.view": "View products",
    "products.manage": "Create and edit products",
    "products.price_update": "Bulk price updates",
    "inventory.view": "View stock",
    "inventory.manage": "Create stock movements, transfers and counts",
    "inventory.post": "Post stock movements, transfers and counts",
    "sales.view": "View sales documents",
    "sales.manage": "Create and edit sales orders",
    "sales.approve": "Approve or reject sales orders",
    "sales.deliver": "Post deliveries",
    "sales.invoice": "Create and post sales invoices",
    "sales.receipt": "Record customer receipts and refunds",
    "sales.return": "Post sales returns and credit notes",
    "purchases.view": "View purchase documents",
    "purchases.manage": "Create and edit purchase orders",
    "purchases.approve": "Approve or reject purchase orders",
    "purchases.receive": "Post goods received notes",
    "purchases.bill": "Create and post supplier bills",
    "purchases.payment": "Record supplier payments",
    "purchases.return": "Post purchase returns",
    "accounting.view": "View accounts, journals and ledgers",
    "accounting.manage": "Edit chart of accounts, draft journals, bank reconciliation",
    "accounting.post": "Post journals",
    "accounting.reverse": "Reverse posted financial documents",
    "expenses.view": "View expenses",
    "expenses.manage": "Create expenses",
    "expenses.approve": "Approve and post expenses",
    "reports.sales": "Sales reports",
    "reports.purchases": "Purchase reports",
    "reports.inventory": "Inventory reports",
    "reports.financial": "Financial reports",
    "audit.view": "View the audit trail",
}

_VIEW = {p for p in ALL_PERMISSIONS if p.endswith(".view")} - {"settings.view"}
_REPORTS = {p for p in ALL_PERMISSIONS if p.startswith("reports.")}

ROLE_PERMISSIONS = {
    Role.SUPER_ADMIN: set(ALL_PERMISSIONS),
    Role.COMPANY_ADMIN: set(ALL_PERMISSIONS),
    Role.MANAGER: (set(ALL_PERMISSIONS) - {"users.manage", "settings.manage", "fiscal.close", "fiscal.reopen", "fiscal.manage"}),
    Role.SALES: {
        "dashboard.view", "customers.view", "customers.manage", "products.view", "inventory.view",
        "sales.view", "sales.manage", "sales.invoice", "sales.receipt", "sales.return", "reports.sales",
    },
    Role.PURCHASE: {
        "dashboard.view", "suppliers.view", "suppliers.manage", "products.view", "products.manage", "inventory.view",
        "purchases.view", "purchases.manage", "purchases.bill", "purchases.return", "reports.purchases",
    },
    Role.WAREHOUSE: {
        "dashboard.view", "products.view", "inventory.view", "inventory.manage", "inventory.post",
        "sales.view", "sales.deliver", "purchases.view", "purchases.receive", "reports.inventory",
    },
    Role.ACCOUNTANT: {
        "dashboard.view", "settings.view", "customers.view", "customers.manage", "suppliers.view", "suppliers.manage",
        "suppliers.bank_view", "products.view", "inventory.view", "sales.view", "sales.invoice", "sales.receipt",
        "sales.return", "purchases.view", "purchases.bill", "purchases.payment", "purchases.return",
        "accounting.view", "accounting.manage", "accounting.post", "accounting.reverse",
        "expenses.view", "expenses.manage", "expenses.approve", "fiscal.view", "fiscal.manage", "audit.view",
    } | _REPORTS,
    Role.AUDITOR: _VIEW | _REPORTS | {"dashboard.view", "settings.view", "audit.view", "suppliers.bank_view"},
}
for _role in (Role.MANAGER, Role.SALES, Role.PURCHASE, Role.WAREHOUSE, Role.ACCOUNTANT, Role.AUDITOR):
    ROLE_PERMISSIONS[_role] |= {"settings.view"} if _role != Role.WAREHOUSE else set()
    ROLE_PERMISSIONS[_role] |= {"fiscal.view"}


def permissions_for(role: str) -> set[str]:
    return set(ROLE_PERMISSIONS.get(role, set()))
