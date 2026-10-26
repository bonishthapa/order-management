"""Fiscal-year configuration, period control and the posting guard.

``get_posting_period`` is called by every financial or inventory posting. It locks the
period row ``FOR SHARE`` so postings run concurrently with each other but serialise against a
period lock / year-end close (which take ``FOR UPDATE``). If the period is locked or the
fiscal year is not postable the whole posting transaction is rejected.
"""
import datetime as dt

from django.db import transaction
from django.utils import timezone

from apps.audit.services import record_event, snapshot
from apps.calendar_utils.bs import ad_to_bs, bs_month_bounds, month_names
from apps.core.exceptions import BusinessRuleError

from .models import (
    POSTABLE_FY_STATUSES,
    AccountingPeriod,
    FiscalYear,
    FiscalYearStatus,
    PeriodStatus,
    PeriodType,
)


def build_periods(start: dt.date, end: dt.date, period_type: str):
    """Return [(name, start, end)] covering [start, end] without gaps."""
    periods = []
    if period_type == PeriodType.SINGLE:
        return [("Full year", start, end)]
    cursor = start
    names = month_names()
    while cursor <= end:
        if period_type == PeriodType.BS_MONTHLY:
            bs = ad_to_bs(cursor)
            _, month_end = bs_month_bounds(bs.year, bs.month)
            name = f"{names[bs.month - 1]} {bs.year}"
        else:
            next_month = (cursor.replace(day=1) + dt.timedelta(days=32)).replace(day=1)
            month_end = next_month - dt.timedelta(days=1)
            name = cursor.strftime("%B %Y")
        period_end = min(month_end, end)
        periods.append((name, cursor, period_end))
        cursor = period_end + dt.timedelta(days=1)
    return periods


def generate_periods(fiscal_year: FiscalYear):
    if fiscal_year.journals.exists():
        raise BusinessRuleError("Periods cannot be regenerated after journals have been posted.")
    fiscal_year.periods.all().delete()
    AccountingPeriod.objects.bulk_create(
        AccountingPeriod(fiscal_year=fiscal_year, number=index, name=name, start_date=start, end_date=end)
        for index, (name, start, end) in enumerate(build_periods(fiscal_year.start_date, fiscal_year.end_date, fiscal_year.period_type), 1)
    )


def validate_no_overlap(organization, start, end, exclude_id=None):
    qs = FiscalYear.objects.filter(organization=organization, start_date__lte=end, end_date__gte=start)
    if exclude_id:
        qs = qs.exclude(pk=exclude_id)
    clash = qs.first()
    if clash:
        raise BusinessRuleError(
            f"The dates overlap fiscal year {clash.name} ({clash.start_date} – {clash.end_date}).", "fiscal_year_overlap"
        )


@transaction.atomic
def create_fiscal_year(organization, user, *, name, code, start_date, end_date, period_type, notes="", request=None):
    if end_date <= start_date:
        raise BusinessRuleError("The end date must be after the start date.")
    if (end_date - start_date).days > 400:
        raise BusinessRuleError("A fiscal year cannot be longer than 400 days.")
    from apps.organizations.models import Organization

    Organization.objects.select_for_update().get(pk=organization.pk)
    validate_no_overlap(organization, start_date, end_date)
    fiscal_year = FiscalYear.objects.create(
        organization=organization, name=name, code=code, start_date=start_date, end_date=end_date,
        period_type=period_type, notes=notes, created_by=user,
    )
    generate_periods(fiscal_year)
    record_event(request or user, "fiscal_year.created", "fiscal_year", fiscal_year, new=snapshot(fiscal_year), organization=organization)
    return fiscal_year


@transaction.atomic
def update_draft_fiscal_year(fiscal_year, user, data, request=None):
    fiscal_year = FiscalYear.objects.select_for_update().get(pk=fiscal_year.pk)
    if fiscal_year.status != FiscalYearStatus.DRAFT:
        raise BusinessRuleError("Only draft fiscal years can be edited.")
    before = snapshot(fiscal_year)
    for key in ("name", "code", "start_date", "end_date", "period_type", "notes"):
        if key in data:
            setattr(fiscal_year, key, data[key])
    if fiscal_year.end_date <= fiscal_year.start_date:
        raise BusinessRuleError("The end date must be after the start date.")
    validate_no_overlap(fiscal_year.organization, fiscal_year.start_date, fiscal_year.end_date, exclude_id=fiscal_year.pk)
    fiscal_year.save()
    generate_periods(fiscal_year)
    record_event(request or user, "fiscal_year.updated", "fiscal_year", fiscal_year, old=before, new=snapshot(fiscal_year))
    return fiscal_year


@transaction.atomic
def activate_fiscal_year(fiscal_year, user, request=None):
    """Make this the current fiscal year. The previously active year stays open for postings
    (status CLOSING) until its year-end close is run."""
    org_years = FiscalYear.objects.select_for_update().filter(organization=fiscal_year.organization)
    fiscal_year = org_years.get(pk=fiscal_year.pk)
    if fiscal_year.status not in (FiscalYearStatus.DRAFT, FiscalYearStatus.CLOSING):
        raise BusinessRuleError(f"A {fiscal_year.get_status_display().lower()} fiscal year cannot be activated.")
    previous = org_years.filter(status=FiscalYearStatus.ACTIVE).exclude(pk=fiscal_year.pk).first()
    if previous:
        if previous.start_date > fiscal_year.start_date:
            raise BusinessRuleError("An earlier fiscal year cannot replace a later active fiscal year.")
        previous.status = FiscalYearStatus.CLOSING
        previous.save(update_fields=["status", "updated_at"])
        record_event(request or user, "fiscal_year.superseded", "fiscal_year", previous, organization=previous.organization)
    fiscal_year.status = FiscalYearStatus.ACTIVE
    fiscal_year.approved_by = user
    fiscal_year.approved_at = timezone.now()
    fiscal_year.save(update_fields=["status", "approved_by", "approved_at", "updated_at"])
    record_event(request or user, "fiscal_year.activated", "fiscal_year", fiscal_year, organization=fiscal_year.organization)
    return fiscal_year


def get_posting_period(organization, date: dt.date) -> AccountingPeriod:
    """Resolve and share-lock the open accounting period for ``date`` or raise BusinessRuleError."""
    from django.db import connection

    if not connection.in_atomic_block:
        raise RuntimeError("get_posting_period must run inside the posting transaction")
    period = (
        AccountingPeriod.objects.select_related("fiscal_year")
        .filter(fiscal_year__organization=organization, start_date__lte=date, end_date__gte=date)
        .first()
    )
    if period is None:
        raise BusinessRuleError(
            f"No accounting period covers {date.isoformat()} (BS {ad_to_bs(date)}). Configure the fiscal year first.",
            "no_period",
        )
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT p.status, f.status FROM fiscal_years_accountingperiod p "
            "JOIN fiscal_years_fiscalyear f ON f.id = p.fiscal_year_id WHERE p.id = %s FOR SHARE OF p, f",
            [period.id],
        )
        period_status, fy_status = cursor.fetchone()
    if fy_status not in POSTABLE_FY_STATUSES:
        label = dict(FiscalYearStatus.choices)[fy_status].lower()
        raise BusinessRuleError(
            f"Fiscal year {period.fiscal_year.name} is {label}; postings dated {date.isoformat()} are not allowed.",
            "fiscal_year_closed",
        )
    if period_status != PeriodStatus.OPEN:
        raise BusinessRuleError(
            f"Accounting period {period.name} is locked; postings dated {date.isoformat()} are not allowed.",
            "period_locked",
        )
    return period


@transaction.atomic
def lock_period(period, user, reason="", request=None):
    period = AccountingPeriod.objects.select_for_update().select_related("fiscal_year").get(pk=period.pk)
    if period.status == PeriodStatus.LOCKED:
        raise BusinessRuleError("The period is already locked.")
    period.status = PeriodStatus.LOCKED
    period.locked_by = user
    period.locked_at = timezone.now()
    period.lock_reason = reason
    period.save()
    record_event(request or user, "period.locked", "accounting_period", period, reason=reason,
                 organization=period.fiscal_year.organization)
    return period


@transaction.atomic
def unlock_period(period, user, reason, request=None):
    if not reason or not reason.strip():
        raise BusinessRuleError("A reason is required to reopen a period.")
    period = AccountingPeriod.objects.select_for_update().select_related("fiscal_year").get(pk=period.pk)
    if period.status != PeriodStatus.LOCKED:
        raise BusinessRuleError("The period is not locked.")
    if period.fiscal_year.status == FiscalYearStatus.CLOSED:
        raise BusinessRuleError("The fiscal year is closed. Reopen the fiscal year first.")
    period.status = PeriodStatus.OPEN
    period.save(update_fields=["status", "updated_at"])
    record_event(request or user, "period.reopened", "accounting_period", period, reason=reason,
                 organization=period.fiscal_year.organization)
    return period
