import threading
from decimal import Decimal

import pytest
from django.db import connection, transaction

from apps.core.exceptions import BusinessRuleError
from apps.inventory import services as stock
from apps.inventory.models import CostLayer, StockLedgerEntry, StockMovement, StockMovementLine, StockTransfer, StockTransferLine

from .conftest import DAY, account_balance, balance, receive_stock

D = Decimal


def issue(org, user, warehouse, product, qty, **kw):
    with transaction.atomic():
        return stock.post_stock(org, movement_type="ISSUE", date=DAY, warehouse=warehouse, user=user,
                                lines=[stock.StockLine(product=product, quantity=-D(qty), **kw)])


def test_receipt_creates_ledger_layer_balance_and_journal(fiscal_year, org, admin, warehouse, product):
    movement = receive_stock(org, admin, warehouse, product, 10, "100")
    b = balance(product, warehouse)
    assert (b.on_hand, b.value) == (D("10"), D("1000.00"))
    assert movement.number.startswith("SM-") and movement.status == "POSTED"
    assert CostLayer.objects.get(product=product).remaining_quantity == D("10")
    assert account_balance(org, "INVENTORY") == D("1000.00")
    assert account_balance(org, "OPENING_EQUITY") == D("-1000.00")


def test_fifo_valuation_across_layers(fiscal_year, org, admin, warehouse, product):
    receive_stock(org, admin, warehouse, product, 10, "100")
    receive_stock(org, admin, warehouse, product, 10, "130")
    _, posted = issue(org, admin, warehouse, product, 15)
    assert posted[0].cost == D("1650.00")  # 10 × 100 + 5 × 130
    b = balance(product, warehouse)
    assert (b.on_hand, b.value) == (D("5"), D("650.00"))
    _, posted = issue(org, admin, warehouse, product, 5)
    assert posted[0].cost == D("650.00")
    assert balance(product, warehouse).value == 0


def test_negative_stock_blocked_by_default_and_nothing_written(fiscal_year, org, admin, warehouse, product):
    receive_stock(org, admin, warehouse, product, 3, "100")
    entries = StockLedgerEntry.objects.count()
    with pytest.raises(BusinessRuleError) as exc:
        issue(org, admin, warehouse, product, 5)
    assert exc.value.get_codes() == "insufficient_stock"
    assert StockLedgerEntry.objects.count() == entries
    assert balance(product, warehouse).on_hand == D("3")


def test_negative_stock_allowed_when_configured(fiscal_year, org, admin, warehouse, product):
    org.negative_stock_policy = "ALLOW"
    org.save()
    receive_stock(org, admin, warehouse, product, 2, "100")
    _, posted = issue(org, admin, warehouse, product, 5)
    assert balance(product, warehouse).on_hand == D("-3")
    assert posted[0].cost == D("500.00")  # uncovered quantity costed at last cost


def test_reservations_reduce_available_and_release(fiscal_year, org, admin, warehouse, product, customer):
    from apps.sales.models import SalesOrder, SalesOrderLine

    receive_stock(org, admin, warehouse, product, 10, "100")
    so = SalesOrder.objects.create(organization=org, number="SO-T", customer=customer, warehouse=warehouse, order_date=DAY)
    line = SalesOrderLine.objects.create(order=so, product=product, quantity=D(8), unit_price=D(150))
    with transaction.atomic():
        assert stock.reserve(line, warehouse, D(8)) == D(8)
        assert stock.reserve(SalesOrderLine.objects.create(order=so, product=product, quantity=D(5), unit_price=D(1)), warehouse, D(5)) == D(2)
    b = balance(product, warehouse)
    assert (b.reserved, b.available) == (D(10), D(0))
    with pytest.raises(BusinessRuleError):
        issue(org, admin, warehouse, product, 1)  # reserved stock cannot be issued manually
    with transaction.atomic():
        stock.release(line, warehouse, D(3))
    assert balance(product, warehouse).reserved == D(7)
    line.refresh_from_db()
    assert line.reserved_quantity == D(5)


def test_transfer_moves_quantity_and_exact_cost_via_transit(fiscal_year, org, admin, warehouse, warehouse2, product):
    receive_stock(org, admin, warehouse, product, 10, "100")
    receive_stock(org, admin, warehouse, product, 10, "120")
    t = StockTransfer.objects.create(organization=org, date=DAY, source_warehouse=warehouse, destination_warehouse=warehouse2)
    StockTransferLine.objects.create(transfer=t, product=product, quantity=D(15))
    stock.dispatch_transfer(t, admin)
    transit = stock.transit_warehouse(org)
    assert balance(product, transit).on_hand == D(15) and balance(product, transit).value == D("1600.00")
    assert balance(product, warehouse2) is None or balance(product, warehouse2).on_hand == 0
    with pytest.raises(BusinessRuleError):
        stock.dispatch_transfer(t, admin)  # cannot dispatch twice
    stock.receive_transfer(t, admin, date=DAY)
    assert balance(product, transit).on_hand == 0 and balance(product, transit).value == 0
    dest = balance(product, warehouse2)
    assert (dest.on_hand, dest.value) == (D(15), D("1600.00"))
    # The destination keeps the original FIFO layers (100 then 120).
    layers = list(CostLayer.objects.filter(product=product, warehouse=warehouse2, remaining_quantity__gt=0).order_by("id"))
    assert [(l.remaining_quantity, l.unit_cost) for l in layers] == [(D(10), D("100.0000")), (D(5), D("120.0000"))]
    assert account_balance(org, "INVENTORY") == D("2200.00")  # transfers never touch the ledger


def test_duplicate_posting_prevented(fiscal_year, org, admin, warehouse, product):
    movement = StockMovement.objects.create(organization=org, movement_type="ADJUSTMENT", date=DAY, warehouse=warehouse, reason="r")
    StockMovementLine.objects.create(movement=movement, product=product, quantity=D(4), unit_cost=D(50))
    stock.post_manual_movement(movement, admin)
    with pytest.raises(BusinessRuleError):
        stock.post_manual_movement(movement, admin)
    assert balance(product, warehouse).on_hand == D(4)


def test_adjustment_and_reversal(fiscal_year, org, admin, warehouse, product):
    receive_stock(org, admin, warehouse, product, 10, "100")
    m = StockMovement.objects.create(organization=org, movement_type="DAMAGE", date=DAY, warehouse=warehouse, reason="water damage")
    StockMovementLine.objects.create(movement=m, product=product, quantity=D(2))
    stock.post_manual_movement(m, admin)
    assert balance(product, warehouse).on_hand == D(8)
    assert account_balance(org, "STOCK_ADJUSTMENT") == D("200.00")
    stock.reverse_movement(m, admin, "found undamaged", date=DAY)
    assert balance(product, warehouse).on_hand == D(10) and balance(product, warehouse).value == D("1000.00")
    assert account_balance(org, "STOCK_ADJUSTMENT") == 0
    m.refresh_from_db()
    assert m.status == "REVERSED"


def test_reversal_refused_when_stock_consumed(fiscal_year, org, admin, warehouse, product):
    opening = receive_stock(org, admin, warehouse, product, 5, "100")
    issue(org, admin, warehouse, product, 2)
    with pytest.raises(BusinessRuleError):
        stock.reverse_movement(opening, admin, "mistake")


def test_stock_count_posts_difference(fiscal_year, org, admin, warehouse, product):
    from apps.inventory.models import StockCount, StockCountLine

    receive_stock(org, admin, warehouse, product, 10, "100")
    count = StockCount.objects.create(organization=org, date=DAY, warehouse=warehouse)
    StockCountLine.objects.create(count=count, product=product, system_quantity=D(10), counted_quantity=D(7))
    stock.post_count(count, admin)
    assert balance(product, warehouse).on_hand == D(7)
    count.refresh_from_db()
    assert count.status == "POSTED" and count.adjustment_movement.movement_type == "COUNT"
    assert account_balance(org, "STOCK_ADJUSTMENT") == D("300.00")


def test_batch_and_serial_tracking(fiscal_year, org, admin, warehouse, vat):
    from apps.organizations.models import UnitOfMeasure
    from apps.products.models import Product

    unit = UnitOfMeasure.objects.get(organization=org, code="PCS")
    batch_p = Product.objects.create(organization=org, sku="B", name="Batch item", unit=unit, track_batches=True)
    serial_p = Product.objects.create(organization=org, sku="S", name="Serial item", unit=unit, track_serials=True)
    with transaction.atomic():
        stock.post_stock(org, movement_type="RECEIPT", date=DAY, warehouse=warehouse, user=admin, lines=[
            stock.StockLine(product=batch_p, quantity=D(5), unit_cost=D(10), batch_number="A1"),
            stock.StockLine(product=batch_p, quantity=D(5), unit_cost=D(12), batch_number="A2"),
            stock.StockLine(product=serial_p, quantity=D(2), unit_cost=D(500), serial_numbers=["X1", "X2"]),
        ])
    with pytest.raises(BusinessRuleError):  # batch must be chosen when several are in stock
        issue(org, admin, warehouse, batch_p, 1)
    _, posted = issue(org, admin, warehouse, batch_p, 3, batch_number="A2")
    assert posted[0].cost == D("36.00")
    with pytest.raises(BusinessRuleError):  # serial count must match quantity
        issue(org, admin, warehouse, serial_p, 1, serial_numbers=[])
    issue(org, admin, warehouse, serial_p, 1, serial_numbers=["X2"])
    assert serial_p.serials.get(serial="X2").status == "DELIVERED"
    with pytest.raises(BusinessRuleError):  # cannot issue the same serial twice
        issue(org, admin, warehouse, serial_p, 1, serial_numbers=["X2"])
    with pytest.raises(BusinessRuleError):  # duplicate serial on receipt
        with transaction.atomic():
            stock.post_stock(org, movement_type="RECEIPT", date=DAY, warehouse=warehouse, user=admin,
                             lines=[stock.StockLine(product=serial_p, quantity=D(1), unit_cost=D(1), serial_numbers=["X1"])])


def test_whole_units_enforced(fiscal_year, org, admin, warehouse, product):
    receive_stock(org, admin, warehouse, product, 10, "100")
    with pytest.raises(BusinessRuleError):
        issue(org, admin, warehouse, product, "1.5")


def test_balances_always_match_ledger(fiscal_year, org, admin, warehouse, warehouse2, product, product2):
    receive_stock(org, admin, warehouse, product, 10, "100")
    receive_stock(org, admin, warehouse, product2, 7, "33.333")
    issue(org, admin, warehouse, product2, 3)
    assert stock.verify_balances(org) == []


@pytest.mark.django_db(transaction=True)
def test_concurrent_issues_never_oversell():
    from apps.fiscal_years import services as fy
    from apps.inventory.models import Warehouse
    from apps.organizations.models import Organization, UnitOfMeasure
    from apps.organizations.setup import bootstrap_organization
    from apps.products.models import Product
    from apps.users.models import User

    from .conftest import FY_END, FY_START

    org = bootstrap_organization(Organization.objects.create(name="C", code="c2"))
    user = User.objects.create_user("w@c.test", "x-Long-password-1", full_name="W")
    fy.activate_fiscal_year(fy.create_fiscal_year(org, user, name="f", code="f", start_date=FY_START, end_date=FY_END,
                                                  period_type="SINGLE"), user)
    wh = Warehouse.objects.create(organization=org, code="W", name="W")
    p = Product.objects.create(organization=org, sku="P", name="P", unit=UnitOfMeasure.objects.get(organization=org, code="PCS"))
    receive_stock(org, user, wh, p, 10, "10")
    successes, failures = [], []

    def worker():
        try:
            with transaction.atomic():
                stock.post_stock(org, movement_type="ISSUE", date=DAY, warehouse=wh, user=user,
                                 lines=[stock.StockLine(product=p, quantity=D(-1))])
            successes.append(1)
        except BusinessRuleError:
            failures.append(1)
        finally:
            connection.close()

    threads = [threading.Thread(target=worker) for _ in range(16)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(successes) == 10 and len(failures) == 6
    assert balance(p, wh).on_hand == 0
    assert stock.verify_balances(org) == []
