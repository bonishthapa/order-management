from decimal import Decimal

import pytest
from rest_framework.test import APIClient

from apps.customers.models import Customer
from apps.inventory.models import Warehouse

from .conftest import DAY, PASSWORD, client_for, make_user

D = Decimal


def test_unauthenticated_requests_rejected(db):
    r = APIClient().get("/api/v1/customers/")
    assert r.status_code == 401


def test_login_refresh_logout_cycle(org, admin):
    c = APIClient()
    r = c.post("/api/v1/auth/login/", {"email": admin.email, "password": PASSWORD}, format="json")
    assert r.status_code == 200
    body = r.json()
    assert body["access"] and body["organization"]["id"] == org.pk and "sales.approve" in body["permissions"]
    cookie = r.cookies["erp_refresh"]
    assert cookie["httponly"] and cookie["path"] == "/api/v1/auth/"
    assert "refresh" not in body  # the refresh token is never exposed to JavaScript
    r = c.post("/api/v1/auth/refresh/")
    assert r.status_code == 200 and r.json()["access"]
    old = cookie.value
    c.cookies["erp_refresh"] = old  # replaying a rotated refresh token fails
    assert c.post("/api/v1/auth/refresh/").status_code == 401
    assert APIClient().post("/api/v1/auth/login/", {"email": admin.email, "password": "wrong"}, format="json").status_code == 401


def test_refresh_rejects_foreign_origin(org, admin):
    c = APIClient()
    c.post("/api/v1/auth/login/", {"email": admin.email, "password": PASSWORD}, format="json")
    assert c.post("/api/v1/auth/refresh/", HTTP_ORIGIN="https://evil.example").status_code == 403


def test_cross_organization_isolation(fiscal_year, org, other_org, admin, customer):
    outsider = make_user(other_org, "COMPANY_ADMIN", "boss@other.test")
    c = client_for(outsider, other_org)
    assert c.get("/api/v1/customers/").json()["count"] == 0
    assert c.get(f"/api/v1/customers/{customer.pk}/").status_code == 404
    assert c.get(f"/api/v1/customers/{customer.pk}/ledger/").status_code == 404
    assert c.patch(f"/api/v1/customers/{customer.pk}/", {"name": "hacked"}, format="json").status_code == 404
    # Pointing the header at an organisation the user does not belong to is refused outright.
    c2 = client_for(outsider, org)
    assert c2.get("/api/v1/customers/").status_code == 403
    assert c2.get("/api/v1/reports/sales-by-date/").status_code == 403
    assert c2.get("/api/v1/customers/export/", {"export": "csv"}).status_code == 403


def test_foreign_ids_in_request_bodies_rejected(fiscal_year, org, other_org, admin, customer, warehouse, product):
    foreign_wh = Warehouse.objects.create(organization=other_org, code="X", name="X")
    foreign_customer = Customer.objects.create(organization=other_org, code="Z", name="Z")
    api = client_for(admin, org)
    r = api.post("/api/v1/sales-orders/", {"customer": foreign_customer.pk, "warehouse": warehouse.pk, "order_date": DAY.isoformat(),
                                           "lines": [{"product": product.pk, "quantity": "1", "unit_price": "1"}]}, format="json")
    assert r.status_code == 400 and "customer" in r.json()["errors"]
    r = api.post("/api/v1/sales-orders/", {"customer": customer.pk, "warehouse": foreign_wh.pk, "order_date": DAY.isoformat(),
                                           "lines": [{"product": product.pk, "quantity": "1", "unit_price": "1"}]}, format="json")
    assert r.status_code == 400 and "warehouse" in r.json()["errors"]


def test_role_permissions(fiscal_year, org, users, customer):
    auditor = client_for(users["AUDITOR"], org)
    assert auditor.get("/api/v1/customers/").status_code == 200
    assert auditor.get("/api/v1/audit-logs/").status_code == 200
    assert auditor.post("/api/v1/customers/", {"name": "x"}, format="json").status_code == 403
    assert auditor.patch(f"/api/v1/customers/{customer.pk}/", {"name": "x"}, format="json").status_code == 403
    warehouse = client_for(users["WAREHOUSE"], org)
    assert warehouse.get("/api/v1/journals/").status_code == 403
    assert warehouse.get("/api/v1/reports/profit-and-loss/").status_code == 403
    assert warehouse.get("/api/v1/audit-logs/").status_code == 403
    sales = client_for(users["SALES"], org)
    assert sales.get("/api/v1/purchase-bills/").status_code == 403
    assert sales.get("/api/v1/users/").status_code == 403
    assert sales.patch("/api/v1/organizations/current/", {"name": "x"}, format="json").status_code == 403
    # Role-aware report index.
    slugs = {r["slug"] for g in sales.get("/api/v1/reports/").json() for r in g["reports"]}
    assert "sales-by-date" in slugs and "trial-balance" not in slugs


def test_supplier_bank_details_restricted(fiscal_year, org, users, supplier):
    purchase = client_for(users["PURCHASE"], org)
    assert purchase.get(f"/api/v1/suppliers/{supplier.pk}/").json()["bank_account_number"] is None
    accountant = client_for(users["ACCOUNTANT"], org)
    assert accountant.get(f"/api/v1/suppliers/{supplier.pk}/").json()["bank_account_number"] == "12345678901234"
    listed = accountant.get("/api/v1/suppliers/").json()["results"][0]["bank_account_number"]
    assert listed.endswith("1234") and listed.startswith("••••")
    purchase.patch(f"/api/v1/suppliers/{supplier.pk}/", {"bank_account_number": "999"}, format="json")
    supplier.refresh_from_db()
    assert supplier.bank_account_number == "12345678901234"


def test_warehouse_restriction(fiscal_year, org, users, warehouse, warehouse2):
    from apps.users.models import Membership

    Membership.objects.get(user=users["WAREHOUSE"]).warehouses.set([warehouse])
    c = client_for(users["WAREHOUSE"], org)
    r = c.post("/api/v1/stock-movements/", {"movement_type": "ADJUSTMENT", "date": DAY.isoformat(), "warehouse": warehouse2.pk,
                                            "reason": "x", "lines": []}, format="json")
    assert r.status_code in (400, 403)


def test_closed_period_rejected_via_api(fiscal_year, org, api, customer, product, warehouse):
    from apps.fiscal_years.services import lock_period

    period = fiscal_year.periods.get(start_date__lte=DAY, end_date__gte=DAY)
    lock_period(period, None)
    r = api.post("/api/v1/sales-invoices/", {"customer": customer.pk, "invoice_date": DAY.isoformat(), "warehouse": warehouse.pk,
                                             "lines": [{"product": product.pk, "quantity": "1", "unit_price": "10"}]}, format="json")
    r = api.post(f"/api/v1/sales-invoices/{r.json()['id']}/post/")
    assert r.status_code == 409 and r.json()["code"] == "period_locked"


def test_client_cannot_set_financial_fields(fiscal_year, org, api, customer, service_product):
    r = api.post("/api/v1/sales-invoices/", {"customer": customer.pk, "invoice_date": DAY.isoformat(), "amount_paid": "999",
                                             "balance_due": "0", "status": "POSTED", "number": "SI-FAKE", "grand_total": "1",
                                             "lines": [{"product": service_product.pk, "quantity": "2", "unit_price": "100",
                                                        "line_total": "1"}]}, format="json")
    body = r.json()
    assert body["status"] == "DRAFT" and body["number"] == "" and body["amount_paid"] == "0.00"
    assert body["grand_total"] == "200.00" and body["lines"][0]["line_total"] == "200.00"


def test_posted_documents_cannot_be_deleted(fiscal_year, org, api, customer, service_product):
    inv = api.post("/api/v1/sales-invoices/", {"customer": customer.pk, "invoice_date": DAY.isoformat(),
                                               "lines": [{"product": service_product.pk, "quantity": "1", "unit_price": "100"}]},
                   format="json").json()
    api.post(f"/api/v1/sales-invoices/{inv['id']}/post/")
    assert api.delete(f"/api/v1/sales-invoices/{inv['id']}/").status_code == 400
    assert api.patch(f"/api/v1/sales-invoices/{inv['id']}/", {"notes": "x"}, format="json").status_code == 409


def test_audit_log_is_read_only(fiscal_year, org, api):
    assert api.post("/api/v1/audit-logs/", {}, format="json").status_code == 405
    from apps.audit.models import AuditEvent

    event = AuditEvent.objects.create(organization=org, action="x", entity_type="y", entity_id="1")
    with pytest.raises(RuntimeError):
        event.save()
    with pytest.raises(RuntimeError):
        event.delete()


def test_user_management(org, users):
    admin = client_for(users["COMPANY_ADMIN"], org)
    r = admin.post("/api/v1/users/", {"email": "new@test.test", "full_name": "New Person", "role": "SALES",
                                      "password": "Another-Long-Pass9"}, format="json")
    assert r.status_code == 201, r.json()
    mid = r.json()["id"]
    assert admin.post("/api/v1/users/", {"email": "x@test.test", "full_name": "X", "role": "SUPER_ADMIN",
                                         "password": "Another-Long-Pass9"}, format="json").status_code == 400
    assert admin.post(f"/api/v1/users/{mid}/deactivate/").json()["is_active"] is False
    login = APIClient().post("/api/v1/auth/login/", {"email": "new@test.test", "password": "Another-Long-Pass9"}, format="json")
    assert login.json()["organization"] is None  # no active membership → no access to the organisation
    assert client_for(users["MANAGER"], org).post("/api/v1/users/", {}, format="json").status_code == 403


def test_attachment_upload_validation(fiscal_year, org, api, users, cash, cash_method):
    from django.core.files.uploadedfile import SimpleUploadedFile

    from apps.expenses.models import Expense, ExpenseCategory

    expense = Expense.objects.create(organization=org, category=ExpenseCategory.objects.filter(organization=org).first(), date=DAY,
                                     payee="x", amount=D(10), payment_method=cash_method, paid_from_account=cash)
    bad = SimpleUploadedFile("bill.pdf", b"MZ\x90\x00 not a pdf", content_type="application/pdf")
    r = api.post("/api/v1/attachments/", {"entity_type": "expense", "entity_id": expense.pk, "file": bad}, format="multipart")
    assert r.status_code == 400
    good = SimpleUploadedFile("bill.pdf", b"%PDF-1.4 test", content_type="application/pdf")
    r = api.post("/api/v1/attachments/", {"entity_type": "expense", "entity_id": expense.pk, "file": good}, format="multipart")
    assert r.status_code == 201
    r = client_for(users["WAREHOUSE"], org).get("/api/v1/attachments/", {"entity_type": "expense", "entity_id": expense.pk})
    assert r.status_code == 403


def test_branch_restriction_limits_warehouses(fiscal_year, org, users, warehouse, warehouse2):
    from apps.organizations.models import Branch
    from apps.users.models import Membership

    branch = Branch.objects.create(organization=org, code="PKR", name="Pokhara")
    warehouse2.branch = branch
    warehouse2.save()
    Membership.objects.get(user=users["WAREHOUSE"]).branches.set([branch])
    c = client_for(users["WAREHOUSE"], org)
    r = c.post("/api/v1/stock-movements/", {"movement_type": "ADJUSTMENT", "date": DAY.isoformat(), "warehouse": warehouse.pk,
                                            "reason": "x", "lines": [{"product": 1, "quantity": "1"}]}, format="json")
    assert r.status_code in (400, 403)
    from apps.inventory.models import StockMovement

    StockMovement.objects.create(organization=org, movement_type="ADJUSTMENT", date=DAY, warehouse=warehouse, reason="hidden")
    visible = StockMovement.objects.create(organization=org, movement_type="ADJUSTMENT", date=DAY, warehouse=warehouse2, reason="mine")
    ids = [m["id"] for m in c.get("/api/v1/stock-movements/").json()["results"]]
    assert ids == [visible.pk]


def test_compact_receipt_pdf(fiscal_year, org, api, customer, cash, cash_method):
    r = api.post("/api/v1/sales-receipts/", {"customer": customer.pk, "date": DAY.isoformat(), "amount": "500",
                                             "payment_method": cash_method.pk, "deposit_account": cash.pk}, format="json")
    pdf = api.get(f"/api/v1/sales-receipts/{r.json()['id']}/pdf/", {"layout": "compact"})
    assert pdf.status_code == 200 and pdf.content[:4] == b"%PDF"
