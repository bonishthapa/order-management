from decimal import Decimal

import pytest

from apps.accounting.ledgers import customer_ledger
from apps.accounting.services import party_balance
from apps.sales.models import SalesInvoice, SalesOrder

from .conftest import DAY, account_balance, balance, client_for, receive_stock

D = Decimal


@pytest.fixture
def stocked(fiscal_year, org, admin, warehouse, product, product2):
    receive_stock(org, admin, warehouse, product, 20, "100")
    receive_stock(org, admin, warehouse, product2, 50, "40")


def create_order(client, customer, warehouse, lines, **extra):
    payload = {"customer": customer.pk, "warehouse": warehouse.pk, "order_date": DAY.isoformat(), "lines": lines, **extra}
    r = client.post("/api/v1/sales-orders/", payload, format="json")
    assert r.status_code == 201, r.json()
    return r.json()


def approve(client, order_id):
    assert client.post(f"/api/v1/sales-orders/{order_id}/submit/").status_code == 200
    r = client.post(f"/api/v1/sales-orders/{order_id}/approve/", {}, format="json")
    assert r.status_code == 200, r.json()
    return r.json()


def deliver(client, order, qty_by_line, date=DAY):
    r = client.post("/api/v1/deliveries/", {"sales_order": order["id"], "date": date.isoformat(), "lines": [
        {"order_line": lid, "quantity": str(q)} for lid, q in qty_by_line.items()]}, format="json")
    assert r.status_code == 201, r.json()
    r2 = client.post(f"/api/v1/deliveries/{r.json()['id']}/post/")
    assert r2.status_code == 200, r2.json()
    return r2.json()


def invoice_from_order(client, order, date=DAY):
    lines = client.get(f"/api/v1/sales-orders/{order['id']}/invoiceable/").json()
    r = client.post("/api/v1/sales-invoices/", {"customer": order["customer"], "sales_order": order["id"],
                                                "invoice_date": date.isoformat(), "lines": [
                                                    {"order_line": l["order_line"], "product": l["product"], "quantity": l["quantity"],
                                                     "unit_price": "1"} for l in lines]}, format="json")
    assert r.status_code == 201, r.json()
    r2 = client.post(f"/api/v1/sales-invoices/{r.json()['id']}/post/")
    assert r2.status_code == 200, r2.json()
    return r2.json()


def test_full_order_to_cash_cycle(stocked, org, api, customer, warehouse, product, product2, cash, cash_method, vat):
    order = create_order(api, customer, warehouse, [
        {"product": product.pk, "quantity": "10", "unit_price": "150", "discount_percent": "10", "tax_rate": vat.pk},
        {"product": product2.pk, "quantity": "5", "unit_price": "60", "tax_rate": vat.pk}],
        freight="200", grand_total="1")
    # Totals are computed on the server: (1500 − 150) + 300 = 1650 taxable, 214.50 VAT, + 200 freight.
    assert (order["taxable_total"], order["tax_total"], order["grand_total"]) == ("1650.00", "214.50", "2064.50")
    assert order["number"].startswith("SO-2083/84-")
    # Creating an order changes neither stock nor the ledger.
    assert balance(product, warehouse).on_hand == D(20) and account_balance(org, "SALES") == 0
    order = approve(api, order["id"])
    assert order["status"] == "APPROVED"
    assert balance(product, warehouse).reserved == D(10)

    l1, l2 = order["lines"]
    deliver(api, order, {l1["id"]: 6})
    order = api.get(f"/api/v1/sales-orders/{order['id']}/").json()
    assert order["status"] == "PARTIAL" and order["fulfilment"]["delivered"] == "6.000"
    assert balance(product, warehouse).on_hand == D(14) and balance(product, warehouse).reserved == D(4)
    assert account_balance(org, "COGS") == D("600.00")  # COGS recognised at delivery, FIFO cost

    inv = invoice_from_order(api, order)
    # Only delivered quantity is invoiced; price comes from the order, not the client ("unit_price": "1").
    assert len(inv["lines"]) == 1 and inv["lines"][0]["unit_price"] == "150.0000" and inv["lines"][0]["quantity"] == "6.000"
    assert inv["grand_total"] == "915.30" and inv["balance_due"] == "915.30" and inv["number"].startswith("SI-2083/84-")
    assert inv["invoice_date_bs"] and inv["due_date_bs"]
    assert account_balance(org, "SALES") == D("-810.00") and account_balance(org, "TAX_PAYABLE") == D("-105.30")
    assert party_balance(org, customer=customer) == D("915.30")

    # Over-invoicing the same delivered lines is rejected.
    lines = api.get(f"/api/v1/sales-orders/{order['id']}/invoiceable/").json()
    assert lines == []

    # Deliver the rest and invoice.
    deliver(api, order, {l1["id"]: 4, l2["id"]: 5})
    order = api.get(f"/api/v1/sales-orders/{order['id']}/").json()
    assert order["status"] == "COMPLETED"
    inv2 = invoice_from_order(api, order)

    # Partial payment, then a single receipt paying two invoices, and an advance left over.
    r = api.post("/api/v1/sales-receipts/", {"customer": customer.pk, "date": DAY.isoformat(), "amount": "500",
                                             "payment_method": cash_method.pk, "deposit_account": cash.pk,
                                             "allocate": [{"document": inv["id"], "amount": "500"}]}, format="json")
    assert r.status_code == 201, r.json()
    inv_now = api.get(f"/api/v1/sales-invoices/{inv['id']}/").json()
    assert inv_now["payment_status"] == "PARTIAL" and inv_now["balance_due"] == "415.30"
    total_open = D(inv_now["balance_due"]) + D(inv2["balance_due"])
    r = api.post("/api/v1/sales-receipts/", {"customer": customer.pk, "date": DAY.isoformat(), "amount": str(total_open + 100),
                                             "payment_method": cash_method.pk, "deposit_account": cash.pk,
                                             "allocate": [{"document": inv["id"], "amount": inv_now["balance_due"]},
                                                          {"document": inv2["id"], "amount": inv2["balance_due"]}]}, format="json")
    assert r.status_code == 201, r.json()
    receipt = r.json()
    assert receipt["unapplied_amount"] == "100.00"
    for i in (inv, inv2):
        assert api.get(f"/api/v1/sales-invoices/{i['id']}/").json()["payment_status"] == "PAID"
    assert party_balance(org, customer=customer) == D("-100.00")  # advance

    # Ledger reconciles with documents.
    ledger = customer_ledger(customer)
    assert ledger["closing_balance"] == D("-100.00")
    assert ledger["total_debit"] == D(inv["grand_total"]) + D(inv2["grand_total"])

    # PDF and timeline.
    pdf = api.get(f"/api/v1/sales-invoices/{inv['id']}/pdf/")
    assert pdf.status_code == 200 and pdf["Content-Type"] == "application/pdf" and pdf.content[:4] == b"%PDF"
    timeline = api.get(f"/api/v1/sales-invoices/{inv['id']}/timeline/").json()
    types = {d["type"] for d in timeline["related"]}
    assert {"sales-order", "delivery", "sales-invoice", "sales-receipt", "journal"} <= types
    assert any(e["action"] == "sales_invoice.posted" for e in timeline["events"])


def test_over_allocation_and_wrong_customer_rejected(stocked, org, api, customer, customer2, warehouse, product, cash,
                                                     cash_method, vat):
    order = approve(api, create_order(api, customer, warehouse, [{"product": product.pk, "quantity": "2", "unit_price": "100",
                                                                   "tax_rate": vat.pk}])["id"])
    deliver(api, order, {order["lines"][0]["id"]: 2})
    inv = invoice_from_order(api, order)
    base = {"date": DAY.isoformat(), "payment_method": cash_method.pk, "deposit_account": cash.pk}
    r = api.post("/api/v1/sales-receipts/", {**base, "customer": customer.pk, "amount": "1000",
                                             "allocate": [{"document": inv["id"], "amount": "999"}]}, format="json")
    assert r.status_code == 409 and r.json()["code"] == "over_allocation"
    r = api.post("/api/v1/sales-receipts/", {**base, "customer": customer.pk, "amount": "10",
                                             "allocate": [{"document": inv["id"], "amount": "20"}]}, format="json")
    assert r.status_code == 409
    r = api.post("/api/v1/sales-receipts/", {**base, "customer": customer2.pk, "amount": "10",
                                             "allocate": [{"document": inv["id"], "amount": "10"}]}, format="json")
    assert r.status_code == 409 and r.json()["code"] == "invalid_allocation"
    # Nothing was written by the failed attempts.
    assert api.get("/api/v1/sales-receipts/").json()["count"] == 0
    assert account_balance(org, "CASH") == 0


def test_receipt_reversal_restores_invoice(stocked, org, api, customer, warehouse, product, cash, cash_method, vat):
    order = approve(api, create_order(api, customer, warehouse, [{"product": product.pk, "quantity": "1", "unit_price": "100",
                                                                   "tax_rate": vat.pk}])["id"])
    deliver(api, order, {order["lines"][0]["id"]: 1})
    inv = invoice_from_order(api, order)
    rec = api.post("/api/v1/sales-receipts/", {"customer": customer.pk, "date": DAY.isoformat(), "amount": "113",
                                               "payment_method": cash_method.pk, "deposit_account": cash.pk,
                                               "allocate": [{"document": inv["id"], "amount": "113"}]}, format="json").json()
    assert api.get(f"/api/v1/sales-invoices/{inv['id']}/").json()["payment_status"] == "PAID"
    r = api.post(f"/api/v1/sales-receipts/{rec['id']}/reverse/", {"reason": "Cheque bounced"}, format="json")
    assert r.status_code == 200 and r.json()["status"] == "REVERSED"
    assert api.get(f"/api/v1/sales-invoices/{inv['id']}/").json()["balance_due"] == "113.00"
    assert party_balance(org, customer=customer) == D("113.00")
    assert api.post(f"/api/v1/sales-receipts/{rec['id']}/reverse/", {"reason": "again"}, format="json").status_code == 409


def test_over_delivery_rejected(stocked, api, customer, warehouse, product, vat):
    order = approve(api, create_order(api, customer, warehouse, [{"product": product.pk, "quantity": "3", "unit_price": "100",
                                                                   "tax_rate": vat.pk}])["id"])
    r = api.post("/api/v1/deliveries/", {"sales_order": order["id"], "date": DAY.isoformat(),
                                         "lines": [{"order_line": order["lines"][0]["id"], "quantity": "5"}]}, format="json")
    did = r.json()["id"]
    r = api.post(f"/api/v1/deliveries/{did}/post/")
    assert r.status_code == 409 and r.json()["code"] == "over_fulfilment"
    assert balance(product, warehouse).on_hand == D(20)


def test_direct_invoice_issues_stock_and_reversal(stocked, org, api, customer, warehouse, product, service_product, vat):
    r = api.post("/api/v1/sales-invoices/", {"customer": customer.pk, "warehouse": warehouse.pk, "invoice_date_bs": "2083-04-21",
                                             "lines": [{"product": product.pk, "quantity": "2", "unit_price": "200", "tax_rate": vat.pk},
                                                       {"product": service_product.pk, "quantity": "1", "unit_price": "500"}]},
                 format="json")
    assert r.status_code == 201, r.json()
    inv = api.post(f"/api/v1/sales-invoices/{r.json()['id']}/post/").json()
    assert inv["status"] == "POSTED" and inv["stock_movement"]
    assert balance(product, warehouse).on_hand == D(18)
    assert account_balance(org, "COGS") == D("200.00")
    r = api.post(f"/api/v1/sales-invoices/{inv['id']}/reverse/", {"reason": "Raised in error"}, format="json")
    assert r.status_code == 200 and r.json()["status"] == "REVERSED"
    assert balance(product, warehouse).on_hand == D(20)
    assert account_balance(org, "COGS") == 0 and account_balance(org, "SALES") == 0
    assert party_balance(org, customer=customer) == 0
    assert api.post(f"/api/v1/sales-invoices/{inv['id']}/post/").status_code == 409  # cannot post twice


def test_sales_return_restock_credit_and_refund(stocked, org, api, customer, warehouse, product, cash, cash_method, vat):
    order = approve(api, create_order(api, customer, warehouse, [{"product": product.pk, "quantity": "5", "unit_price": "200",
                                                                   "tax_rate": vat.pk}])["id"])
    deliver(api, order, {order["lines"][0]["id"]: 5})
    inv = invoice_from_order(api, order)  # 1000 + 130 = 1130
    api.post("/api/v1/sales-receipts/", {"customer": customer.pk, "date": DAY.isoformat(), "amount": "1130",
                                         "payment_method": cash_method.pk, "deposit_account": cash.pk,
                                         "allocate": [{"document": inv["id"], "amount": "1130"}]}, format="json")
    line_id = inv["lines"][0]["id"]
    r = api.post("/api/v1/sales-returns/", {"invoice": inv["id"], "warehouse": warehouse.pk, "date": DAY.isoformat(),
                                            "reason": "Wrong colour", "lines": [{"invoice_line": line_id, "quantity": "2",
                                                                                 "inspection": "RESTOCK"}]}, format="json")
    assert r.status_code == 201, r.json()
    ret = api.post(f"/api/v1/sales-returns/{r.json()['id']}/post/").json()
    assert ret["grand_total"] == "452.00" and ret["number"].startswith("CN-")
    assert ret["unapplied_credit"] == "452.00"  # invoice already paid, credit held for the customer
    assert balance(product, warehouse).on_hand == D(17)  # 20 − 5 + 2
    assert account_balance(org, "COGS") == D("300.00")  # 500 issued − 200 restocked
    assert party_balance(org, customer=customer) == D("-452.00")
    # Over-return is rejected.
    r = api.post("/api/v1/sales-returns/", {"invoice": inv["id"], "warehouse": warehouse.pk, "date": DAY.isoformat(),
                                            "reason": "x", "lines": [{"invoice_line": line_id, "quantity": "4"}]}, format="json")
    assert r.status_code == 400
    # Refund the credit.
    r = api.post("/api/v1/customer-refunds/", {"customer": customer.pk, "credit_note": ret["id"], "date": DAY.isoformat(),
                                               "amount": "452", "payment_method": cash_method.pk, "paid_from_account": cash.pk},
                 format="json")
    assert r.status_code == 201, r.json()
    assert party_balance(org, customer=customer) == 0
    r = api.post("/api/v1/customer-refunds/", {"customer": customer.pk, "credit_note": ret["id"], "date": DAY.isoformat(),
                                               "amount": "1", "payment_method": cash_method.pk, "paid_from_account": cash.pk},
                 format="json")
    assert r.status_code == 409


def test_return_credit_applied_to_unpaid_invoice(stocked, org, api, customer, warehouse, product, vat):
    order = approve(api, create_order(api, customer, warehouse, [{"product": product.pk, "quantity": "4", "unit_price": "100",
                                                                   "tax_rate": vat.pk}])["id"])
    deliver(api, order, {order["lines"][0]["id"]: 4})
    inv = invoice_from_order(api, order)
    r = api.post("/api/v1/sales-returns/", {"invoice": inv["id"], "warehouse": warehouse.pk, "date": DAY.isoformat(),
                                            "reason": "Damaged", "lines": [{"invoice_line": inv["lines"][0]["id"], "quantity": "1",
                                                                            "inspection": "DAMAGED"}]}, format="json")
    ret = api.post(f"/api/v1/sales-returns/{r.json()['id']}/post/").json()
    inv = api.get(f"/api/v1/sales-invoices/{inv['id']}/").json()
    assert inv["amount_credited"] == "113.00" and inv["balance_due"] == "339.00"
    assert balance(product, warehouse).on_hand == D(16)  # damaged goods are not restocked
    assert account_balance(org, "COGS") == D("400.00")


def test_credit_limit_blocks_approval_without_override(stocked, org, api, customer, warehouse, product, vat):
    customer.credit_limit = D("100")
    customer.save()
    order = create_order(api, customer, warehouse, [{"product": product.pk, "quantity": "5", "unit_price": "100", "tax_rate": vat.pk}])
    api.post(f"/api/v1/sales-orders/{order['id']}/submit/")
    r = api.post(f"/api/v1/sales-orders/{order['id']}/approve/", {}, format="json")
    assert r.status_code == 409 and r.json()["code"] == "credit_limit"
    r = api.post(f"/api/v1/sales-orders/{order['id']}/approve/", {"override_credit_limit": True}, format="json")
    assert r.status_code == 200


def test_cancel_releases_reservations_and_reject_flow(stocked, api, customer, warehouse, product, vat, users, org):
    order = approve(api, create_order(api, customer, warehouse, [{"product": product.pk, "quantity": "5", "unit_price": "1",
                                                                   "tax_rate": vat.pk}])["id"])
    assert balance(product, warehouse).reserved == D(5)
    r = api.post(f"/api/v1/sales-orders/{order['id']}/cancel/", {"reason": "Customer cancelled"}, format="json")
    assert r.json()["status"] == "CANCELLED" and balance(product, warehouse).reserved == 0
    sales = client_for(users["SALES"], org)
    o2 = create_order(sales, customer, warehouse, [{"product": product.pk, "quantity": "1", "unit_price": "1"}])
    sales.post(f"/api/v1/sales-orders/{o2['id']}/submit/")
    assert sales.post(f"/api/v1/sales-orders/{o2['id']}/approve/", {}, format="json").status_code == 403
    r = client_for(users["MANAGER"], org).post(f"/api/v1/sales-orders/{o2['id']}/reject/", {"reason": "Price too low"}, format="json")
    assert r.json()["status"] == "REJECTED"
    r = sales.patch(f"/api/v1/sales-orders/{o2['id']}/", {"notes": "revised"}, format="json")
    assert r.status_code == 200 and r.json()["status"] == "DRAFT"


def test_backorder_reservation_when_stock_arrives(fiscal_year, org, admin, api, customer, warehouse, product, vat):
    receive_stock(org, admin, warehouse, product, 3, "100")
    order = approve(api, create_order(api, customer, warehouse, [{"product": product.pk, "quantity": "5", "unit_price": "1",
                                                                   "tax_rate": vat.pk}])["id"])
    assert order["lines"][0]["reserved_quantity"] == "3.000" and order["fulfilment"]["backorder"] == "2.000"
    receive_stock(org, admin, warehouse, product, 10, "100")
    order = api.post(f"/api/v1/sales-orders/{order['id']}/reserve/").json()
    assert order["lines"][0]["reserved_quantity"] == "5.000"


def test_invoice_before_delivery_policy(stocked, org, api, customer, warehouse, product, vat):
    order = approve(api, create_order(api, customer, warehouse, [{"product": product.pk, "quantity": "2", "unit_price": "1",
                                                                   "tax_rate": vat.pk}])["id"])
    assert api.get(f"/api/v1/sales-orders/{order['id']}/invoiceable/").json() == []
    org.allow_invoice_before_delivery = True
    org.save()
    assert len(api.get(f"/api/v1/sales-orders/{order['id']}/invoiceable/").json()) == 1


def test_documents_and_reports_render(stocked, org, api, customer, warehouse, product, vat):
    order = approve(api, create_order(api, customer, warehouse, [{"product": product.pk, "quantity": "2", "unit_price": "100",
                                                                   "tax_rate": vat.pk}])["id"])
    d = deliver(api, order, {order["lines"][0]["id"]: 2})
    inv = invoice_from_order(api, order)
    for url in (f"/api/v1/sales-orders/{order['id']}/pdf/", f"/api/v1/deliveries/{d['id']}/pdf/",
                f"/api/v1/sales-invoices/{inv['id']}/pdf/", f"/api/v1/customers/{customer.pk}/statement/"):
        r = api.get(url)
        assert r.status_code == 200 and r.content[:4] == b"%PDF", url
    # Second print of an invoice is labelled as a copy.
    assert SalesInvoice.objects.get(pk=inv["id"]).print_count == 1
    api.get(f"/api/v1/sales-invoices/{inv['id']}/pdf/")
    assert SalesInvoice.objects.get(pk=inv["id"]).print_count == 2
