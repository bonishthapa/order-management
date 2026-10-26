from decimal import Decimal

import pytest
from django.db import connection, transaction
from django.db.utils import DatabaseError

from apps.accounting.models import Account, JournalEntry, JournalLine, SystemAccount
from apps.accounting.services import Line, post_journal, reverse_journal, trial_balance
from apps.core.exceptions import BusinessRuleError

from .conftest import DAY, client_for

D = Decimal


@pytest.fixture
def accts(org):
    get = lambda **kw: Account.objects.get(organization=org, **kw)  # noqa: E731
    return {"cash": get(system_key="CASH"), "bank": get(system_key="BANK"), "capital": get(code="3100"),
            "rent": get(code="6100"), "ar": get(system_key="RECEIVABLE"), "group": get(code="1000")}


def test_balanced_journal_posts(fiscal_year, org, accts):
    with transaction.atomic():
        e = post_journal(org, date=DAY, lines=[Line(accts["cash"], debit=D("10")), Line(accts["capital"], credit=D("10"))])
    assert e.status == "POSTED" and e.total_debit == e.total_credit == D("10")
    assert e.number.startswith("JV-2083/84-")


def test_unbalanced_rejected(fiscal_year, org, accts):
    with pytest.raises(BusinessRuleError), transaction.atomic():
        post_journal(org, date=DAY, lines=[Line(accts["cash"], debit=D("10")), Line(accts["capital"], credit=D("9"))])


def test_database_trigger_rejects_unbalanced_posted_entry(fiscal_year, org, accts):
    with transaction.atomic():
        e = post_journal(org, date=DAY, lines=[Line(accts["cash"], debit=D("10")), Line(accts["capital"], credit=D("10"))])
    with pytest.raises(DatabaseError), transaction.atomic():
        with connection.cursor() as c:
            c.execute("SET CONSTRAINTS ALL IMMEDIATE")
        # Attempt to tamper with a posted line directly in SQL.
        JournalLine.objects.filter(entry=e, debit__gt=0).update(debit=D("11"))


def test_group_and_inactive_accounts_rejected(fiscal_year, org, accts):
    with pytest.raises(BusinessRuleError), transaction.atomic():
        post_journal(org, date=DAY, lines=[Line(accts["group"], debit=D("1")), Line(accts["capital"], credit=D("1"))])


def test_receivable_lines_require_customer(fiscal_year, org, accts):
    with pytest.raises(BusinessRuleError), transaction.atomic():
        post_journal(org, date=DAY, lines=[Line(accts["ar"], debit=D("1")), Line(accts["capital"], credit=D("1"))])


def test_idempotent_posting(fiscal_year, org, accts):
    lines = [Line(accts["cash"], debit=D("10")), Line(accts["capital"], credit=D("10"))]
    with transaction.atomic():
        post_journal(org, date=DAY, lines=lines, idempotency_key="SI:1")
    with pytest.raises(BusinessRuleError) as exc, transaction.atomic():
        post_journal(org, date=DAY, lines=lines, idempotency_key="SI:1")
    assert exc.value.get_codes() == "duplicate_posting"
    assert JournalEntry.objects.filter(idempotency_key="SI:1").count() == 1


def test_reversal_mirrors_and_cannot_repeat(fiscal_year, org, accts, admin):
    with transaction.atomic():
        e = post_journal(org, date=DAY, lines=[Line(accts["rent"], debit=D("40")), Line(accts["cash"], credit=D("40"))])
        r = reverse_journal(e, date=DAY, user=admin, reason="wrong account")
    assert r.reversal_of == e
    assert {(l.account_id, l.debit, l.credit) for l in r.lines.all()} == {
        (accts["rent"].pk, 0, D("40")), (accts["cash"].pk, D("40"), 0)}
    with pytest.raises(BusinessRuleError), transaction.atomic():
        reverse_journal(e, date=DAY, user=admin, reason="again")


def test_trial_balance_totals_agree(fiscal_year, org, accts):
    with transaction.atomic():
        post_journal(org, date=DAY, lines=[Line(accts["bank"], debit=D("5000")), Line(accts["capital"], credit=D("5000"))])
        post_journal(org, date=DAY, lines=[Line(accts["rent"], debit=D("1200")), Line(accts["bank"], credit=D("1200"))])
    rows = trial_balance(org)
    assert sum(r["debit"] for r in rows) == sum(r["credit"] for r in rows)
    assert sum(r["closing"] for r in rows) == 0


def test_manual_journal_api_draft_post_reverse(fiscal_year, org, users, accts):
    accountant = client_for(users["ACCOUNTANT"], org)
    payload = {"date_bs": "2083-04-21", "narration": "Owner introduces capital", "source": "MANUAL", "lines": [
        {"account": accts["bank"].pk, "debit": "100000", "credit": "0"},
        {"account": accts["capital"].pk, "debit": "0", "credit": "100000"}]}
    r = accountant.post("/api/v1/journals/", payload, format="json")
    assert r.status_code == 201, r.json()
    jid = r.json()["id"]
    assert r.json()["status"] == "DRAFT" and r.json()["date_bs"] == "2083-04-21"
    r = accountant.post(f"/api/v1/journals/{jid}/post/")
    assert r.status_code == 200 and r.json()["status"] == "POSTED"
    r = accountant.patch(f"/api/v1/journals/{jid}/", {"narration": "edit"}, format="json")
    assert r.status_code == 409  # posted journals are immutable
    r = accountant.post(f"/api/v1/journals/{jid}/reverse/", {"reason": "duplicate entry"}, format="json")
    assert r.status_code == 200 and r.json()["reversal_of"] == jid
    sales = client_for(users["SALES"], org)
    assert sales.post("/api/v1/journals/", payload, format="json").status_code == 403


def test_manual_journal_rejects_unbalanced_on_post(fiscal_year, org, api, accts):
    payload = {"date": DAY.isoformat(), "narration": "x", "source": "MANUAL", "lines": [
        {"account": accts["bank"].pk, "debit": "10", "credit": "0"}, {"account": accts["capital"].pk, "debit": "0", "credit": "9"}]}
    jid = api.post("/api/v1/journals/", payload, format="json").json()["id"]
    r = api.post(f"/api/v1/journals/{jid}/post/")
    assert r.status_code == 409 and r.json()["code"] == "unbalanced"


def test_system_accounts_protected(api, org, accts):
    r = api.delete(f"/api/v1/accounts/{accts['cash'].pk}/")
    assert r.status_code == 409
    r = api.patch(f"/api/v1/accounts/{accts['cash'].pk}/", {"account_type": "EXPENSE"}, format="json")
    assert r.status_code == 400


def test_opening_balances_post_once(fiscal_year, org, api, customer, supplier):
    r = api.post(f"/api/v1/customers/{customer.pk}/opening-balance/", {"amount": "25000", "date_bs": "2083-04-01"}, format="json")
    assert r.status_code == 200 and r.json()["balance"] == "25000.00" and r.json()["opening_balance_posted"]
    r = api.post(f"/api/v1/customers/{customer.pk}/opening-balance/", {"amount": "1", "date_bs": "2083-04-01"}, format="json")
    assert r.status_code == 409
    r = api.patch(f"/api/v1/customers/{customer.pk}/", {"opening_balance": "999"}, format="json")
    assert r.json()["opening_balance"] == "25000.00"  # read-only once posted
    r = api.post(f"/api/v1/suppliers/{supplier.pk}/opening-balance/", {"amount": "8000", "date": DAY.isoformat()}, format="json")
    assert r.json()["balance"] == "8000.00"


def test_expense_approval_flow(fiscal_year, org, users, cash, cash_method, vat):
    from apps.expenses.models import ExpenseCategory

    category = ExpenseCategory.objects.get(organization=org, name="Utilities")
    accountant = client_for(users["ACCOUNTANT"], org)
    r = accountant.post("/api/v1/expenses/", {"category": category.pk, "date": DAY.isoformat(), "payee": "NEA", "amount": "1000",
                                              "tax_rate": vat.pk, "payment_method": cash_method.pk, "paid_from_account": cash.pk,
                                              "total": "1"}, format="json")
    assert r.status_code == 201, r.json()
    eid = r.json()["id"]
    assert r.json()["total"] == "1130.00"  # server-calculated, client value ignored
    assert accountant.post(f"/api/v1/expenses/{eid}/submit/").json()["status"] == "SUBMITTED"
    assert client_for(users["SALES"], org).post(f"/api/v1/expenses/{eid}/approve/").status_code == 403
    r = client_for(users["MANAGER"], org).post(f"/api/v1/expenses/{eid}/approve/")
    assert r.status_code == 200 and r.json()["status"] == "POSTED" and r.json()["number"].startswith("EX-")
    from .conftest import account_balance

    assert account_balance(org, "TAX_RECEIVABLE") == D("130.00")
    assert account_balance(org, "CASH") == D("-1130.00")


def test_bank_reconciliation(fiscal_year, org, api, accts):
    with transaction.atomic():
        e1 = post_journal(org, date=DAY, lines=[Line(accts["bank"], debit=D("1000")), Line(accts["capital"], credit=D("1000"))])
        post_journal(org, date=DAY, lines=[Line(accts["rent"], debit=D("300")), Line(accts["bank"], credit=D("300"))])
    r = api.get("/api/v1/bank-reconciliations/unreconciled/", {"account": accts["bank"].pk, "statement_date": DAY.isoformat()})
    assert r.status_code == 200 and len(r.json()["lines"]) == 2
    line = e1.lines.get(account=accts["bank"])
    r = api.post("/api/v1/bank-reconciliations/reconcile/", {"account": accts["bank"].pk, "statement_date": DAY.isoformat(),
                                                             "statement_balance": "1000", "cleared_lines": [line.pk]}, format="json")
    assert r.status_code == 200 and r.json()["difference"] == "0.00"
    line.refresh_from_db()
    assert line.cleared_date == DAY
