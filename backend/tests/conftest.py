import datetime as dt
from decimal import Decimal

import pytest
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from apps.calendar_utils.bs import bs_to_ad

D = Decimal
PASSWORD = "Correct-Horse-42"


@pytest.fixture
def org(db):
    from apps.organizations.models import Organization
    from apps.organizations.setup import bootstrap_organization

    return bootstrap_organization(Organization.objects.create(name="Test Traders", code="test", require_expense_approval=True))


@pytest.fixture
def other_org(db):
    from apps.organizations.models import Organization
    from apps.organizations.setup import bootstrap_organization

    return bootstrap_organization(Organization.objects.create(name="Other Co", code="other"))


def make_user(org, role, email=None):
    from apps.users.models import Membership, User

    user = User.objects.create_user(email or f"{role.lower()}@{org.code}.test", PASSWORD, full_name=role.title(),
                                    default_organization=org)
    Membership.objects.create(user=user, organization=org, role=role)
    return user


@pytest.fixture
def admin(org):
    return make_user(org, "COMPANY_ADMIN")


@pytest.fixture
def users(org, admin):
    roles = ["MANAGER", "SALES", "PURCHASE", "WAREHOUSE", "ACCOUNTANT", "AUDITOR"]
    result = {r: make_user(org, r) for r in roles}
    result["COMPANY_ADMIN"] = admin
    return result


def client_for(user, org=None):
    client = APIClient()
    token = RefreshToken.for_user(user).access_token
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
    if org is not None:
        client.defaults["HTTP_X_ORGANIZATION_ID"] = str(org.pk)
    return client


@pytest.fixture
def api(admin, org):
    return client_for(admin, org)


# Fiscal year 2083/84 BS: 1 Shrawan 2083 – 32 Ashadh 2084 (2026-07-17 – 2027-07-16).
FY_START = bs_to_ad((2083, 4, 1))
FY_END = bs_to_ad((2084, 4, 1)) - dt.timedelta(days=1)
DAY = FY_START + dt.timedelta(days=20)


@pytest.fixture
def fiscal_year(org, admin):
    from apps.fiscal_years import services

    fy = services.create_fiscal_year(org, admin, name="2083/84", code="2083/84", start_date=FY_START, end_date=FY_END,
                                     period_type="BS_MONTHLY")
    return services.activate_fiscal_year(fy, admin)


@pytest.fixture
def warehouse(org):
    from apps.inventory.models import Warehouse

    return Warehouse.objects.create(organization=org, code="MAIN", name="Main warehouse")


@pytest.fixture
def warehouse2(org):
    from apps.inventory.models import Warehouse

    return Warehouse.objects.create(organization=org, code="DEP", name="Depot")


@pytest.fixture
def vat(org):
    from apps.organizations.models import TaxRate

    return TaxRate.objects.get(organization=org, name="VAT 13%")


@pytest.fixture
def product(org, vat):
    from apps.organizations.models import UnitOfMeasure
    from apps.products.models import Product

    return Product.objects.create(organization=org, sku="P1", name="Widget", unit=UnitOfMeasure.objects.get(organization=org, code="PCS"),
                                  purchase_price=D("100"), selling_price=D("150"), tax_rate=vat)


@pytest.fixture
def product2(org, vat):
    from apps.organizations.models import UnitOfMeasure
    from apps.products.models import Product

    return Product.objects.create(organization=org, sku="P2", name="Gadget", unit=UnitOfMeasure.objects.get(organization=org, code="PCS"),
                                  purchase_price=D("40"), selling_price=D("60"), tax_rate=vat)


@pytest.fixture
def service_product(org, vat):
    from apps.organizations.models import UnitOfMeasure
    from apps.products.models import Product

    return Product.objects.create(organization=org, sku="SRV", name="Installation", product_type="SERVICE",
                                  unit=UnitOfMeasure.objects.get(organization=org, code="HR"), selling_price=D("500"), tax_rate=vat)


@pytest.fixture
def customer(org):
    from apps.customers.models import Customer

    return Customer.objects.create(organization=org, code="C1", name="Acme Retail", payment_terms_days=30)


@pytest.fixture
def customer2(org):
    from apps.customers.models import Customer

    return Customer.objects.create(organization=org, code="C2", name="Beta Stores", payment_terms_days=15)


@pytest.fixture
def supplier(org):
    from apps.suppliers.models import Supplier

    return Supplier.objects.create(organization=org, code="S1", name="Prime Supplies", payment_terms_days=30,
                                   bank_account_number="12345678901234")


@pytest.fixture
def cash(org):
    from apps.accounting.models import Account

    return Account.objects.get(organization=org, system_key="CASH")


@pytest.fixture
def bank(org):
    from apps.accounting.models import Account

    return Account.objects.get(organization=org, system_key="BANK")


@pytest.fixture
def cash_method(org):
    from apps.organizations.models import PaymentMethod

    return PaymentMethod.objects.get(organization=org, name="Cash")


def receive_stock(org, user, warehouse, product, quantity, unit_cost, date=DAY):
    """Opening stock helper: posts a real OPENING movement."""
    from apps.inventory.models import StockMovement, StockMovementLine
    from apps.inventory.services import post_manual_movement

    movement = StockMovement.objects.create(organization=org, movement_type="OPENING", date=date, warehouse=warehouse,
                                            reason="test stock", created_by=user)
    StockMovementLine.objects.create(movement=movement, product=product, quantity=D(quantity), unit_cost=D(unit_cost))
    return post_manual_movement(movement, user)


def balance(product, warehouse):
    from apps.inventory.models import StockBalance

    return StockBalance.objects.filter(product=product, warehouse=warehouse).first()


def account_balance(org, key):
    from apps.accounting.models import Account
    from apps.accounting.services import account_balance as ab

    return ab(Account.objects.get(organization=org, system_key=key))
