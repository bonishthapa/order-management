import datetime as dt
import threading
from decimal import Decimal

import pytest
from django.db import IntegrityError, connection, transaction

from apps.accounting.models import Account, JournalEntry, SystemAccount
from apps.accounting.services import Line, post_journal
from apps.calendar_utils.bs import bs_to_ad
from apps.core.exceptions import BusinessRuleError
from apps.core.numbering import next_number
from apps.fiscal_years import closing, services
from apps.fiscal_years.models import AccountingPeriod, FiscalYear, PeriodStatus
from apps.fiscal_years.services import get_posting_period

from .conftest import DAY, FY_END, FY_START, client_for, make_user

D = Decimal


def _journal(org, date, amount="100", key=""):
    cash = Account.objects.get(organization=org, system_key=SystemAccount.CASH)
    capital = Account.objects.get(organization=org, code="3100")
    with transaction.atomic():
        return post_journal(org, date=date, lines=[Line(cash, debit=D(amount)), Line(capital, credit=D(amount))],
                            idempotency_key=key, narration="test")


def test_create_generates_bs_monthly_periods(fiscal_year):
    periods = list(fiscal_year.periods.order_by("number"))
    assert len(periods) == 12
    assert periods[0].name == "Shrawan 2083" and periods[0].start_date == FY_START
    assert periods[-1].name == "Ashadh 2084" and periods[-1].end_date == FY_END
    for a, b in zip(periods, periods[1:]):
        assert b.start_date == a.end_date + dt.timedelta(days=1)
    assert fiscal_year.start_date_bs == "2083-04-01"


def test_ad_monthly_and_single_period(org, admin):
    fy = services.create_fiscal_year(org, admin, name="2030", code="2030", start_date=dt.date(2030, 1, 1),
                                     end_date=dt.date(2030, 12, 31), period_type="AD_MONTHLY")
    assert fy.periods.count() == 12 and fy.periods.first().name == "January 2030"
    fy2 = services.create_fiscal_year(org, admin, name="2031", code="2031", start_date=dt.date(2031, 1, 1),
                                      end_date=dt.date(2031, 12, 31), period_type="SINGLE")
    assert fy2.periods.count() == 1


def test_overlapping_fiscal_year_rejected(fiscal_year, org, admin):
    with pytest.raises(BusinessRuleError):
        services.create_fiscal_year(org, admin, name="X", code="X", start_date=FY_END - dt.timedelta(days=10),
                                    end_date=FY_END + dt.timedelta(days=300), period_type="SINGLE")


def test_overlap_blocked_by_database_constraint(fiscal_year, org):
    with pytest.raises(IntegrityError), transaction.atomic():
        FiscalYear.objects.create(organization=org, name="dup", code="dup", start_date=FY_START + dt.timedelta(days=5),
                                  end_date=FY_END + dt.timedelta(days=5))


def test_other_org_can_use_same_dates(fiscal_year, other_org, admin):
    fy = services.create_fiscal_year(other_org, admin, name="2083/84", code="2083/84", start_date=FY_START, end_date=FY_END,
                                     period_type="BS_MONTHLY")
    assert fy.pk


def test_only_one_active_and_previous_moves_to_closing(fiscal_year, org, admin):
    nxt = services.create_fiscal_year(org, admin, name="2084/85", code="2084/85", start_date=FY_END + dt.timedelta(days=1),
                                      end_date=bs_to_ad((2085, 4, 1)) - dt.timedelta(days=1), period_type="BS_MONTHLY")
    services.activate_fiscal_year(nxt, admin)
    fiscal_year.refresh_from_db()
    assert fiscal_year.status == "CLOSING"
    assert FiscalYear.objects.filter(organization=org, status="ACTIVE").count() == 1
    # Postings into the previous (still open) year are allowed.
    with transaction.atomic():
        assert get_posting_period(org, DAY).fiscal_year == fiscal_year


def test_transaction_assigned_to_correct_year_and_period(fiscal_year, org):
    entry = _journal(org, DAY)
    assert entry.fiscal_year == fiscal_year
    assert entry.period.start_date <= DAY <= entry.period.end_date


def test_posting_without_fiscal_year_rejected(fiscal_year, org):
    with pytest.raises(BusinessRuleError) as exc:
        _journal(org, FY_START - dt.timedelta(days=1))
    assert exc.value.get_codes() == "no_period"


def test_draft_fiscal_year_rejects_postings(org, admin):
    services.create_fiscal_year(org, admin, name="d", code="d", start_date=FY_START, end_date=FY_END, period_type="SINGLE")
    with pytest.raises(BusinessRuleError) as exc:
        _journal(org, DAY)
    assert exc.value.get_codes() == "fiscal_year_closed"


def test_locked_period_rejects_postings_and_failed_posting_leaves_nothing(fiscal_year, org, admin):
    period = AccountingPeriod.objects.get(fiscal_year=fiscal_year, start_date__lte=DAY, end_date__gte=DAY)
    services.lock_period(period, admin, "month end")
    before = JournalEntry.objects.count()
    with pytest.raises(BusinessRuleError) as exc:
        _journal(org, DAY)
    assert exc.value.get_codes() == "period_locked"
    assert JournalEntry.objects.count() == before


def test_unlock_requires_reason_and_is_audited(fiscal_year, admin):
    from apps.audit.models import AuditEvent

    period = fiscal_year.periods.first()
    services.lock_period(period, admin)
    with pytest.raises(BusinessRuleError):
        services.unlock_period(period, admin, "")
    services.unlock_period(period, admin, "Correcting a misposted invoice")
    period.refresh_from_db()
    assert period.status == PeriodStatus.OPEN
    event = AuditEvent.objects.get(action="period.reopened", entity_id=str(period.pk))
    assert event.reason == "Correcting a misposted invoice"


def test_unlock_permission_enforced_via_api(fiscal_year, org, users):
    period = fiscal_year.periods.first()
    services.lock_period(period, users["COMPANY_ADMIN"])
    r = client_for(users["ACCOUNTANT"], org).post(f"/api/v1/accounting-periods/{period.pk}/unlock/", {"reason": "x"}, format="json")
    assert r.status_code == 403  # accountants may lock but not reopen
    r = client_for(users["COMPANY_ADMIN"], org).post(f"/api/v1/accounting-periods/{period.pk}/unlock/", {"reason": "fix"}, format="json")
    assert r.status_code == 200 and r.json()["status"] == "OPEN"


def test_fiscal_year_numbering_resets_per_year(fiscal_year, org, admin):
    nxt = services.create_fiscal_year(org, admin, name="2084/85", code="2084/85", start_date=FY_END + dt.timedelta(days=1),
                                      end_date=bs_to_ad((2085, 4, 1)) - dt.timedelta(days=1), period_type="SINGLE")
    with transaction.atomic():
        a = next_number(org, "SI", DAY)
        b = next_number(org, "SI", DAY)
        c = next_number(org, "SI", nxt.start_date)
    assert (a, b, c) == ("SI-2083/84-000001", "SI-2083/84-000002", "SI-2084/85-000001")


def test_numbering_policies(org, fiscal_year):
    from apps.organizations.models import NumberingPolicy

    NumberingPolicy.objects.filter(organization=org, doc_type="PO").update(reset_policy="CONTINUOUS", padding=4, separator="/")
    NumberingPolicy.objects.filter(organization=org, doc_type="SO").update(reset_policy="CALENDAR_BS", include_branch=True)
    with transaction.atomic():
        assert next_number(org, "PO", DAY) == "PO/0001"
        assert next_number(org, "SO", DAY, "KTM") == "SO-KTM-2083-000001"
        assert next_number(org, "SO", DAY, "PKR") == "SO-PKR-2083-000001"


def test_number_rolled_back_with_failed_transaction(fiscal_year, org):
    try:
        with transaction.atomic():
            next_number(org, "SI", DAY)
            raise RuntimeError
    except RuntimeError:
        pass
    with transaction.atomic():
        assert next_number(org, "SI", DAY) == "SI-2083/84-000001"


@pytest.mark.django_db(transaction=True)
def test_concurrent_numbering_produces_unique_sequence():
    from apps.organizations.models import Organization
    from apps.organizations.setup import bootstrap_organization
    from apps.users.models import User

    org = bootstrap_organization(Organization.objects.create(name="Concurrent", code="conc"))
    user = User.objects.create_user("c@c.test", "x-Long-password-1", full_name="C")
    services.activate_fiscal_year(services.create_fiscal_year(org, user, name="2083/84", code="2083/84", start_date=FY_START,
                                                              end_date=FY_END, period_type="SINGLE"), user)
    results, errors = [], []

    def worker():
        try:
            for _ in range(10):
                with transaction.atomic():
                    results.append(next_number(org, "SI", DAY))
        except Exception as exc:  # pragma: no cover - reported below
            errors.append(exc)
        finally:
            connection.close()

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors
    assert len(results) == 80 and len(set(results)) == 80
    assert sorted(results)[-1] == "SI-2083/84-000080"


def test_year_end_close_carries_forward_and_locks(fiscal_year, org, admin):
    from apps.accounting.services import account_balance

    sales = Account.objects.get(organization=org, system_key=SystemAccount.SALES)
    cash = Account.objects.get(organization=org, system_key=SystemAccount.CASH)
    rent = Account.objects.get(organization=org, code="6100")
    with transaction.atomic():
        post_journal(org, date=DAY, lines=[Line(cash, debit=D("1000")), Line(sales, credit=D("1000"))])
        post_journal(org, date=DAY, lines=[Line(rent, debit=D("300")), Line(cash, credit=D("300"))])
    nxt = services.create_fiscal_year(org, admin, name="2084/85", code="2084/85", start_date=FY_END + dt.timedelta(days=1),
                                      end_date=bs_to_ad((2085, 4, 1)) - dt.timedelta(days=1), period_type="BS_MONTHLY")
    services.activate_fiscal_year(nxt, admin)
    preview = closing.preview(fiscal_year)
    assert preview["can_close"], preview["blockers"]
    assert preview["totals"]["net_profit"] == "700.00"
    with pytest.raises(BusinessRuleError):
        closing.close(fiscal_year, admin, "wrong-code")
    closing.close(fiscal_year, admin, fiscal_year.code)
    fiscal_year.refresh_from_db()
    assert fiscal_year.status == "CLOSED"
    assert not fiscal_year.periods.filter(status="OPEN").exists()
    retained = Account.objects.get(organization=org, system_key=SystemAccount.RETAINED_EARNINGS)
    assert account_balance(retained) == D("-700.00")  # credit balance
    assert account_balance(sales) == 0 and account_balance(rent) == 0
    assert account_balance(cash) == D("700.00")  # balance-sheet accounts carry forward unchanged
    nxt.refresh_from_db()
    assert nxt.opening_balance_status == "CARRIED_FORWARD"
    # Closed year rejects postings.
    with pytest.raises(BusinessRuleError):
        _journal(org, DAY)
    # Historical P&L for the closed year still shows the original figures (closing entries excluded).
    from apps.reports.definitions import Ctx, profit_and_loss
    from apps.calendar_utils.ranges import DateRange

    pl = profit_and_loss(Ctx(org, DateRange(fiscal_year.start_date, fiscal_year.end_date), {}))
    assert pl["summary"]["net_profit"] == D("700.00")


def test_close_blocked_by_drafts_and_requires_no_auto_close(fiscal_year, org, admin, customer):
    from apps.sales.models import SalesInvoice

    SalesInvoice.objects.create(organization=org, customer=customer, invoice_date=DAY, due_date=DAY)
    preview = closing.preview(fiscal_year)
    assert not preview["can_close"]
    with pytest.raises(BusinessRuleError):
        closing.close(fiscal_year, admin, fiscal_year.code)
    fiscal_year.refresh_from_db()
    assert fiscal_year.status == "ACTIVE"  # nothing changes automatically


def test_reopen_requires_reason_and_reverses_closing(fiscal_year, org, admin):
    cash = Account.objects.get(organization=org, system_key=SystemAccount.CASH)
    sales = Account.objects.get(organization=org, system_key=SystemAccount.SALES)
    with transaction.atomic():
        post_journal(org, date=DAY, lines=[Line(cash, debit=D("500")), Line(sales, credit=D("500"))])
    closing.close(fiscal_year, admin, fiscal_year.code)
    with pytest.raises(BusinessRuleError):
        closing.reopen(fiscal_year, admin, " ")
    closing.reopen(fiscal_year, admin, "Auditor adjustment")
    fiscal_year.refresh_from_db()
    assert fiscal_year.status == "REOPENED"
    from apps.accounting.services import account_balance

    assert account_balance(sales) == D("-500.00")
    # Periods stay locked until reopened individually with a reason.
    with pytest.raises(BusinessRuleError):
        _journal(org, DAY)
    period = AccountingPeriod.objects.get(fiscal_year=fiscal_year, start_date__lte=DAY, end_date__gte=DAY)
    services.unlock_period(period, admin, "Auditor adjustment")
    assert _journal(org, DAY).pk


def test_reopen_permission(fiscal_year, org, users):
    closing.close(fiscal_year, users["COMPANY_ADMIN"], fiscal_year.code)
    r = client_for(users["MANAGER"], org).post(f"/api/v1/fiscal-years/{fiscal_year.pk}/reopen/", {"reason": "x"}, format="json")
    assert r.status_code == 403


def test_fiscal_year_api_accepts_bs_dates(api, org):
    r = api.post("/api/v1/fiscal-years/", {"name": "2083/84", "code": "2083/84", "start_date_bs": "2083-04-01",
                                           "end_date_bs": "2084-03-32", "period_type": "BS_MONTHLY"}, format="json")
    assert r.status_code == 201, r.json()
    body = r.json()
    assert body["start_date"] == "2026-07-17" and body["end_date_bs"] == "2084-03-32"
    assert len(body["periods"]) == 12
    r = api.post("/api/v1/fiscal-years/", {"name": "x", "code": "x", "start_date_bs": "2084-01-01", "end_date_bs": "2084-12-30",
                                           "period_type": "SINGLE"}, format="json")
    assert r.status_code == 409 and r.json()["code"] == "fiscal_year_overlap"
