from decimal import Decimal

import pytest

from apps.accounting.ledgers import supplier_ledger
from apps.accounting.services import party_balance

from .conftest import DAY, account_balance, balance, client_for

D = Decimal


@pytest.fixture
def purchaser(fiscal_year, org, users):
    return client_for(users["PURCHASE"], org)


def make_po(client, supplier, warehouse, lines, approve_with=None):
    r = client.post("/api/v1/purchase-orders/", {"supplier": supplier.pk, "warehouse": warehouse.pk, "order_date": DAY.isoformat(),
                                                 "lines": lines}, format="json")
    assert r.status_code == 201, r.json()
    po = r.json()
    assert client.post(f"/api/v1/purchase-orders/{po['id']}/submit/").status_code == 200
    r = (approve_with or client).post(f"/api/v1/purchase-orders/{po['id']}/approve/")
    assert r.status_code == 200, r.json()
    return r.json()


def receive(client, po, lines):
    r = client.post("/api/v1/goods-received-notes/", {"purchase_order": po["id"], "date": DAY.isoformat(), "lines": lines}, format="json")
    assert r.status_code == 201, r.json()
    r = client.post(f"/api/v1/goods-received-notes/{r.json()['id']}/post/")
    assert r.status_code == 200, r.json()
    return r.json()


def bill_from_po(client, supplier, po, invoice_no, price_override=None):
    rows = client.get(f"/api/v1/purchase-orders/{po['id']}/billable/").json()
    lines = [{"receipt_line": r["receipt_line"], "order_line": r["order_line"], "product": r["product"], "quantity": r["quantity"],
              "unit_price": price_override or r["unit_price"], "tax_rate": r["tax_rate"]} for r in rows]
    r = client.post("/api/v1/purchase-bills/", {"supplier": supplier.pk, "purchase_order": po["id"], "supplier_invoice_number": invoice_no,
                                                "bill_date": DAY.isoformat(), "lines": lines}, format="json")
    assert r.status_code == 201, r.json()
    return r.json()


def test_procure_to_pay_cycle(org, users, purchaser, supplier, warehouse, product, product2, vat, bank):
    manager = client_for(users["MANAGER"], org)
    warehouse_client = client_for(users["WAREHOUSE"], org)
    accountant = client_for(users["ACCOUNTANT"], org)
    assert purchaser.post("/api/v1/purchase-orders/", {}, format="json").status_code == 400
    po = make_po(purchaser, supplier, warehouse, [
        {"product": product.pk, "quantity": "10", "unit_price": "100", "discount_percent": "5", "tax_rate": vat.pk},
        {"product": product2.pk, "quantity": "20", "unit_price": "40", "tax_rate": vat.pk}], approve_with=manager)
    assert po["status"] == "APPROVED" and po["grand_total"] == "1977.50"  # (950 + 800) × 1.13
    assert balance(product, warehouse) is None  # ordering does not touch stock

    l1, l2 = po["lines"]
    # Partial receipt with a rejected unit.
    grn = receive(warehouse_client, po, [{"order_line": l1["id"], "received_quantity": "6", "rejected_quantity": "1",
                                          "rejection_reason": "Broken seal"}])
    assert grn["total_value"] == "475.00"  # 5 accepted × 95 net
    assert balance(product, warehouse).on_hand == D(5)
    assert account_balance(org, "INVENTORY") == D("475.00") and account_balance(org, "GRNI") == D("-475.00")
    po = purchaser.get(f"/api/v1/purchase-orders/{po['id']}/").json()
    assert po["status"] == "PARTIAL"
    assert (po["lines"][0]["received_quantity"], po["lines"][0]["rejected_quantity"]) == ("5.000", "1.000")
    # Over-receipt is rejected.
    r = warehouse_client.post("/api/v1/goods-received-notes/", {"purchase_order": po["id"], "date": DAY.isoformat(),
                                                                "lines": [{"order_line": l1["id"], "received_quantity": "6"}]}, format="json")
    assert warehouse_client.post(f"/api/v1/goods-received-notes/{r.json()['id']}/post/").json()["code"] == "over_receipt"
    receive(warehouse_client, po, [{"order_line": l1["id"], "received_quantity": "5"}, {"order_line": l2["id"], "received_quantity": "20"}])
    assert purchaser.get(f"/api/v1/purchase-orders/{po['id']}/").json()["status"] == "COMPLETED"

    # Bill everything received; one price differs from the PO → purchase price variance.
    bill = bill_from_po(accountant, supplier, po, "INV-778")
    r = accountant.post(f"/api/v1/purchase-bills/{bill['id']}/post/")
    assert r.status_code == 200, r.json()
    bill = r.json()
    assert bill["grand_total"] == "1977.50" and bill["number"].startswith("PB-")
    assert account_balance(org, "GRNI") == 0
    assert party_balance(org, supplier=supplier) == D("1977.50")
    assert account_balance(org, "TAX_RECEIVABLE") == D("227.50")
    # Duplicate supplier invoice reference is detected.
    r = accountant.post("/api/v1/purchase-bills/", {"supplier": supplier.pk, "supplier_invoice_number": "inv-778",
                                                    "bill_date": DAY.isoformat(), "warehouse": warehouse.pk,
                                                    "lines": [{"product": product.pk, "quantity": "1", "unit_price": "1"}]}, format="json")
    assert r.status_code == 400 and "supplier_invoice_number" in r.json()["errors"]

    # Partial then full payment through vouchers (draft → posted).
    base = {"supplier": supplier.pk, "date": DAY.isoformat(), "payment_method": bank.organization.payment_methods.get(name="Bank transfer").pk,
            "paid_from_account": bank.pk, "reference": "TRF-1"}
    r = accountant.post("/api/v1/payment-vouchers/", {**base, "amount": "1000", "allocate": [{"document": bill["id"], "amount": "1000"}]},
                        format="json")
    assert r.status_code == 201, r.json()
    voucher = r.json()
    assert voucher["status"] == "DRAFT" and party_balance(org, supplier=supplier) == D("1977.50")
    r = accountant.post(f"/api/v1/payment-vouchers/{voucher['id']}/post/")
    assert r.status_code == 200 and r.json()["number"].startswith("PV-")
    assert accountant.post(f"/api/v1/payment-vouchers/{voucher['id']}/post/").status_code == 409  # never twice
    bill = accountant.get(f"/api/v1/purchase-bills/{bill['id']}/").json()
    assert bill["payment_status"] == "PARTIAL" and bill["balance_due"] == "977.50"
    r = accountant.post("/api/v1/payment-vouchers/", {**base, "amount": "977.50", "allocate": [{"document": bill["id"], "amount": "977.50"}]},
                        format="json")
    accountant.post(f"/api/v1/payment-vouchers/{r.json()['id']}/post/")
    assert accountant.get(f"/api/v1/purchase-bills/{bill['id']}/").json()["payment_status"] == "PAID"
    assert party_balance(org, supplier=supplier) == 0
    assert supplier_ledger(supplier)["closing_balance"] == 0
    assert account_balance(org, "BANK") == D("-1977.50")
    for url in (f"/api/v1/purchase-orders/{po['id']}/pdf/", f"/api/v1/goods-received-notes/{grn['id']}/pdf/",
                f"/api/v1/purchase-bills/{bill['id']}/pdf/", f"/api/v1/payment-vouchers/{voucher['id']}/pdf/"):
        assert accountant.get(url).content[:4] == b"%PDF", url


def test_price_variance_and_purchase_return(org, users, purchaser, supplier, warehouse, product, vat):
    manager = client_for(users["MANAGER"], org)
    po = make_po(purchaser, supplier, warehouse, [{"product": product.pk, "quantity": "10", "unit_price": "100", "tax_rate": vat.pk}],
                 approve_with=manager)
    receive(client_for(users["WAREHOUSE"], org), po, [{"order_line": po["lines"][0]["id"], "received_quantity": "10"}])
    accountant = client_for(users["ACCOUNTANT"], org)
    bill = bill_from_po(accountant, supplier, po, "X-1", price_override="105")
    bill = accountant.post(f"/api/v1/purchase-bills/{bill['id']}/post/").json()
    assert account_balance(org, "PURCHASE_VARIANCE") == D("50.00")
    assert account_balance(org, "INVENTORY") == D("1000.00")
    r = accountant.post("/api/v1/purchase-returns/", {"bill": bill["id"], "warehouse": warehouse.pk, "date": DAY.isoformat(),
                                                      "reason": "Defective", "lines": [{"bill_line": bill["lines"][0]["id"], "quantity": "2"}]},
                        format="json")
    assert r.status_code == 201, r.json()
    ret = accountant.post(f"/api/v1/purchase-returns/{r.json()['id']}/post/").json()
    assert ret["grand_total"] == "237.30" and ret["number"].startswith("DBN-")
    assert balance(product, warehouse).on_hand == D(8)
    assert account_balance(org, "INVENTORY") == D("800.00")
    assert account_balance(org, "PURCHASE_VARIANCE") == D("40.00")  # 10 of the variance returned with the goods
    bill = accountant.get(f"/api/v1/purchase-bills/{bill['id']}/").json()
    assert bill["amount_credited"] == "237.30"
    assert party_balance(org, supplier=supplier) == D(bill["grand_total"]) - D("237.30")
    r = accountant.post("/api/v1/purchase-returns/", {"bill": bill["id"], "warehouse": warehouse.pk, "date": DAY.isoformat(),
                                                      "reason": "x", "lines": [{"bill_line": bill["lines"][0]["id"], "quantity": "9"}]},
                        format="json")
    assert r.status_code == 400


def test_direct_bill_with_service_and_stock(fiscal_year, org, users, supplier, warehouse, product, service_product, vat):
    accountant = client_for(users["ACCOUNTANT"], org)
    r = accountant.post("/api/v1/purchase-bills/", {"supplier": supplier.pk, "supplier_invoice_number": "D-1", "bill_date": DAY.isoformat(),
                                                    "warehouse": warehouse.pk, "freight": "100", "lines": [
                                                        {"product": product.pk, "quantity": "3", "unit_price": "90", "tax_rate": vat.pk},
                                                        {"product": service_product.pk, "quantity": "2", "unit_price": "250"}]},
                        format="json")
    bill = accountant.post(f"/api/v1/purchase-bills/{r.json()['id']}/post/").json()
    assert bill["status"] == "POSTED" and bill["stock_movement"]
    assert balance(product, warehouse).on_hand == D(3)
    assert account_balance(org, "INVENTORY") == D("270.00")
    assert account_balance(org, "SERVICE_PURCHASES") == D("500.00")
    assert account_balance(org, "FREIGHT_IN") == D("100.00")
    r = accountant.post(f"/api/v1/purchase-bills/{bill['id']}/reverse/", {"reason": "duplicate"}, format="json")
    assert r.status_code == 200 and balance(product, warehouse).on_hand == 0
    assert party_balance(org, supplier=supplier) == 0


def test_supplier_advance_and_refund(fiscal_year, org, users, supplier, bank):
    accountant = client_for(users["ACCOUNTANT"], org)
    method = org.payment_methods.get(name="Bank transfer")
    v = accountant.post("/api/v1/payment-vouchers/", {"supplier": supplier.pk, "date": DAY.isoformat(), "amount": "5000",
                                                      "payment_method": method.pk, "paid_from_account": bank.pk, "reference": "ADV"},
                        format="json").json()
    v = accountant.post(f"/api/v1/payment-vouchers/{v['id']}/post/").json()
    assert v["unapplied_amount"] == "5000.00" and party_balance(org, supplier=supplier) == D("-5000.00")
    r = accountant.post("/api/v1/supplier-refunds/", {"supplier": supplier.pk, "voucher": v["id"], "date": DAY.isoformat(), "amount": "2000",
                                                      "payment_method": method.pk, "deposit_account": bank.pk}, format="json")
    assert r.status_code == 201, r.json()
    assert party_balance(org, supplier=supplier) == D("-3000.00")
    r = accountant.post(f"/api/v1/payment-vouchers/{v['id']}/reverse/", {"reason": "x"}, format="json")
    assert r.status_code == 409  # refund must be reversed first


def test_grn_reversal(org, users, purchaser, supplier, warehouse, product, vat):
    po = make_po(purchaser, supplier, warehouse, [{"product": product.pk, "quantity": "4", "unit_price": "10", "tax_rate": vat.pk}],
                 approve_with=client_for(users["MANAGER"], org))
    wh = client_for(users["WAREHOUSE"], org)
    grn = receive(wh, po, [{"order_line": po["lines"][0]["id"], "received_quantity": "4"}])
    r = wh.post(f"/api/v1/goods-received-notes/{grn['id']}/reverse/", {"reason": "wrong PO"}, format="json")
    assert r.status_code == 200 and r.json()["status"] == "REVERSED"
    assert balance(product, warehouse).on_hand == 0 and account_balance(org, "GRNI") == 0
    assert purchaser.get(f"/api/v1/purchase-orders/{po['id']}/").json()["status"] == "APPROVED"
