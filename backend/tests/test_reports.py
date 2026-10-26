import csv
import io
from decimal import Decimal

import pytest

from apps.reports.registry import REPORTS

from .conftest import DAY, client_for, receive_stock
from .test_sales import approve, create_order, deliver, invoice_from_order

D = Decimal


@pytest.fixture
def activity(fiscal_year, org, admin, api, customer, warehouse, product, vat, cash, cash_method):
    receive_stock(org, admin, warehouse, product, 20, "100")
    order = approve(api, create_order(api, customer, warehouse, [{"product": product.pk, "quantity": "5", "unit_price": "200",
                                                                   "tax_rate": vat.pk}])["id"])
    deliver(api, order, {order["lines"][0]["id"]: 5})
    inv = invoice_from_order(api, order)
    api.post("/api/v1/sales-receipts/", {"customer": customer.pk, "date": DAY.isoformat(), "amount": "500",
                                         "payment_method": cash_method.pk, "deposit_account": cash.pk,
                                         "allocate": [{"document": inv["id"], "amount": "500"}]}, format="json")
    return inv


def test_every_report_runs_with_fiscal_year_and_bs_range(activity, api, fiscal_year):
    for slug in REPORTS:
        for params in ({"fiscal_year": fiscal_year.pk}, {"date_from_bs": "2083-04-01", "date_to_bs": "2083-06-15"},
                       {"fiscal_year": "current", "as_of_bs": "2083-05-10"}):
            r = api.get(f"/api/v1/reports/{slug}/", params)
            assert r.status_code == 200, (slug, params, r.content[:300])
            body = r.json()
            assert body["columns"] and "basis" in body and "rows" in body


def test_sales_report_separates_revenue_and_cash(activity, api, fiscal_year):
    sales = api.get("/api/v1/reports/sales-by-date/", {"fiscal_year": fiscal_year.pk}).json()
    assert sales["totals"]["net_sales"] == "1000.00" and sales["totals"]["total"] == "1130.00"
    cash = api.get("/api/v1/reports/payment-collection/", {"fiscal_year": fiscal_year.pk}).json()
    assert cash["totals"]["amount"] == "500.00"
    gp = api.get("/api/v1/reports/sales-by-product/", {"fiscal_year": fiscal_year.pk}).json()
    row = gp["rows"][0]
    assert (row["revenue"], row["cost"], row["gross_profit"]) == ("1000.00", "500.00", "500.00")
    pl = api.get("/api/v1/reports/profit-and-loss/", {"fiscal_year": fiscal_year.pk}).json()
    assert pl["summary"]["gross_profit"] == "500.00"
    tb = api.get("/api/v1/reports/trial-balance/", {"fiscal_year": fiscal_year.pk}).json()
    assert tb["totals"]["debit"] == tb["totals"]["credit"]
    bs = api.get("/api/v1/reports/balance-sheet/", {"as_of": DAY.isoformat()}).json()
    assert bs["summary"]["difference"] == "0.00"
    aging = api.get("/api/v1/reports/receivable-aging/", {"as_of": DAY.isoformat()}).json()
    assert aging["totals"]["total"] == "630.00"


def test_date_range_excludes_outside_activity(activity, api):
    r = api.get("/api/v1/reports/sales-by-date/", {"date_from_bs": "2083-07-01", "date_to_bs": "2083-07-15"}).json()
    assert r["rows"] == [] and r["range"]["start_bs"] == "2083-07-01"


def test_exports_include_ad_and_bs_dates(activity, api, fiscal_year):
    r = api.get("/api/v1/reports/sales-returns/", {"fiscal_year": fiscal_year.pk, "export": "csv"})
    assert r.status_code == 200 and r["Content-Type"].startswith("text/csv")
    r = api.get("/api/v1/sales-invoices/", {"fiscal_year": fiscal_year.pk})
    r = api.get(f"/api/v1/customers/{activity['customer']}/ledger/", {"fiscal_year": fiscal_year.pk, "export": "csv"})
    rows = list(csv.reader(io.StringIO(r.content.decode("utf-8-sig"))))
    header = next(row for row in rows if row and row[0].startswith("Date"))
    assert header[:2] == ["Date (AD)", "Date (BS)"]
    data = rows[rows.index(header) + 1]
    assert data[1].startswith("2083-")
    r = api.get("/api/v1/reports/trial-balance/", {"fiscal_year": fiscal_year.pk, "export": "xlsx"})
    assert r.status_code == 200 and r.content[:2] == b"PK"
    r = api.get("/api/v1/reports/profit-and-loss/", {"fiscal_year": fiscal_year.pk, "export": "pdf"})
    assert r.status_code == 200 and r.content[:4] == b"%PDF"


def test_dashboard_respects_permissions(activity, org, users, api):
    full = api.get("/api/v1/reports/dashboard/").json()
    assert full["sales"]["period"] == "1000.00" and full["finance"]["receivables"] == "630.00"
    assert full["inventory"]["value"] == "1500.00"
    wh = client_for(users["WAREHOUSE"], org).get("/api/v1/reports/dashboard/").json()
    assert "finance" not in wh and "inventory" in wh


def test_stock_reports_as_of(activity, api, product):
    before = api.get("/api/v1/reports/inventory-valuation/", {"as_of": "2026-07-01"}).json()
    assert before["rows"] == []
    after = api.get("/api/v1/reports/inventory-valuation/", {"as_of": DAY.isoformat()}).json()
    assert after["totals"]["value"] == "1500.00"
    movement = api.get("/api/v1/reports/stock-movement/", {"date_from": DAY.isoformat(), "date_to": DAY.isoformat()}).json()
    row = movement["rows"][0]
    assert (row["in_qty"], row["out_qty"], row["closing_qty"]) == ("20.000", "5.000", "15.000")


def test_inventory_api_transfer_and_count(fiscal_year, org, admin, api, warehouse, warehouse2, product):
    receive_stock(org, admin, warehouse, product, 10, "50")
    r = api.post("/api/v1/stock-transfers/", {"date": DAY.isoformat(), "source_warehouse": warehouse.pk,
                                              "destination_warehouse": warehouse2.pk,
                                              "lines": [{"product": product.pk, "quantity": "4"}]}, format="json")
    assert r.status_code == 201, r.json()
    tid = r.json()["id"]
    assert api.post(f"/api/v1/stock-transfers/{tid}/dispatch/").json()["status"] == "IN_TRANSIT"
    assert api.post(f"/api/v1/stock-transfers/{tid}/receive/", {"date": DAY.isoformat()}, format="json").json()["status"] == "RECEIVED"
    r = api.post("/api/v1/stock-counts/", {"date": DAY.isoformat(), "warehouse": warehouse.pk, "lines": []}, format="json")
    cid = r.json()["id"]
    count = api.post(f"/api/v1/stock-counts/{cid}/populate/").json()
    assert count["lines"][0]["system_quantity"] == "6.000"
    line = count["lines"][0]
    api.patch(f"/api/v1/stock-counts/{cid}/", {"lines": [{"product": line["product"], "counted_quantity": "5"}]}, format="json")
    assert api.post(f"/api/v1/stock-counts/{cid}/post/").json()["status"] == "POSTED"
    balances = api.get("/api/v1/inventory/balances/", {"product": product.pk}).json()["results"]
    assert {b["warehouse_code"]: b["on_hand"] for b in balances} == {"MAIN": "5.000", "DEP": "4.000"}
    ledger = api.get("/api/v1/inventory/ledger/", {"product": product.pk, "date_from_bs": "2083-04-01"}).json()
    assert ledger["count"] >= 4 and ledger["results"][0]["movement_number"]
