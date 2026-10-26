import datetime as dt

from django.conf import settings
from django.contrib.postgres.constraints import ExclusionConstraint
from django.contrib.postgres.fields import DateRangeField, RangeOperators
from django.db import models
from django.db.models import Func, Q
from django.utils import timezone

from apps.calendar_utils.fields import bs_or_none
from apps.core.models import TimeStampedModel


class DateRangeFunc(Func):
    function = "DATERANGE"
    output_field = DateRangeField()


class FiscalYearStatus(models.TextChoices):
    DRAFT = "DRAFT", "Draft"
    ACTIVE = "ACTIVE", "Active"
    CLOSING = "CLOSING", "Open – pending year-end"
    CLOSED = "CLOSED", "Closed"
    REOPENED = "REOPENED", "Reopened"


POSTABLE_FY_STATUSES = (FiscalYearStatus.ACTIVE, FiscalYearStatus.CLOSING, FiscalYearStatus.REOPENED)


class PeriodType(models.TextChoices):
    BS_MONTHLY = "BS_MONTHLY", "Monthly (BS months)"
    AD_MONTHLY = "AD_MONTHLY", "Monthly (AD months)"
    SINGLE = "SINGLE", "Single period"


class OpeningBalanceStatus(models.TextChoices):
    PENDING = "PENDING", "Pending"
    POSTED = "POSTED", "Posted"
    CARRIED_FORWARD = "CARRIED_FORWARD", "Carried forward"


class ClosingStatus(models.TextChoices):
    OPEN = "OPEN", "Not closed"
    CLOSED = "CLOSED", "Closed"


class FiscalYear(TimeStampedModel):
    organization = models.ForeignKey("organizations.Organization", on_delete=models.PROTECT, related_name="fiscal_years")
    name = models.CharField(max_length=60)
    code = models.CharField(max_length=20, help_text="Used in document numbers, e.g. 2083/84")
    start_date = models.DateField()
    end_date = models.DateField()
    period_type = models.CharField(max_length=12, choices=PeriodType.choices, default=PeriodType.BS_MONTHLY)
    status = models.CharField(max_length=10, choices=FiscalYearStatus.choices, default=FiscalYearStatus.DRAFT)
    opening_balance_status = models.CharField(
        max_length=16, choices=OpeningBalanceStatus.choices, default=OpeningBalanceStatus.PENDING
    )
    closing_status = models.CharField(max_length=8, choices=ClosingStatus.choices, default=ClosingStatus.OPEN)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, related_name="+")
    approved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )
    approved_at = models.DateTimeField(null=True, blank=True)
    closed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    closed_at = models.DateTimeField(null=True, blank=True)
    notes = models.TextField(blank=True)

    class Meta:
        ordering = ["-start_date"]
        constraints = [
            models.UniqueConstraint(fields=["organization", "code"], name="uniq_fiscal_year_code"),
            models.UniqueConstraint(
                fields=["organization"], condition=Q(status="ACTIVE"), name="one_active_fiscal_year"
            ),
            models.CheckConstraint(condition=Q(end_date__gt=models.F("start_date")), name="fiscal_year_dates_ordered"),
            ExclusionConstraint(
                name="fiscal_years_do_not_overlap",
                expressions=[
                    ("organization", RangeOperators.EQUAL),
                    (DateRangeFunc("start_date", "end_date", models.Value("[]")), RangeOperators.OVERLAPS),
                ],
            ),
        ]

    def __str__(self):
        return self.name

    @property
    def start_date_bs(self):
        return bs_or_none(self.start_date)

    @property
    def end_date_bs(self):
        return bs_or_none(self.end_date)

    @property
    def is_postable(self):
        return self.status in POSTABLE_FY_STATUSES

    def contains(self, date: dt.date) -> bool:
        return self.start_date <= date <= self.end_date

    @classmethod
    def for_date(cls, organization, date):
        return cls.objects.filter(organization=organization, start_date__lte=date, end_date__gte=date).first()

    @classmethod
    def current(cls, organization):
        active = cls.objects.filter(organization=organization, status=FiscalYearStatus.ACTIVE).first()
        return active or cls.for_date(organization, timezone.localdate())

    @classmethod
    def resolve(cls, organization, value):
        """Accepts a fiscal year id, ``current`` or ``previous``."""
        if value in (None, "", "current"):
            return cls.current(organization)
        if value == "previous":
            current = cls.current(organization)
            if current is None:
                return None
            return (
                cls.objects.filter(organization=organization, end_date__lt=current.start_date)
                .order_by("-end_date")
                .first()
            )
        try:
            return cls.objects.get(organization=organization, pk=int(value))
        except (ValueError, TypeError, cls.DoesNotExist):
            return None


class PeriodStatus(models.TextChoices):
    OPEN = "OPEN", "Open"
    LOCKED = "LOCKED", "Locked"


class AccountingPeriod(TimeStampedModel):
    fiscal_year = models.ForeignKey(FiscalYear, on_delete=models.CASCADE, related_name="periods")
    number = models.PositiveSmallIntegerField()
    name = models.CharField(max_length=60)
    start_date = models.DateField()
    end_date = models.DateField()
    status = models.CharField(max_length=8, choices=PeriodStatus.choices, default=PeriodStatus.OPEN)
    locked_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    locked_at = models.DateTimeField(null=True, blank=True)
    lock_reason = models.TextField(blank=True)

    class Meta:
        ordering = ["fiscal_year", "number"]
        constraints = [
            models.UniqueConstraint(fields=["fiscal_year", "number"], name="uniq_period_number"),
            models.CheckConstraint(condition=Q(end_date__gte=models.F("start_date")), name="period_dates_ordered"),
        ]

    def __str__(self):
        return f"{self.name} ({self.fiscal_year.code})"

    @property
    def start_date_bs(self):
        return bs_or_none(self.start_date)

    @property
    def end_date_bs(self):
        return bs_or_none(self.end_date)


class FiscalYearClosing(TimeStampedModel):
    """Result of a completed year-end close: the validated preview and the closing journal."""

    fiscal_year = models.ForeignKey(FiscalYear, on_delete=models.PROTECT, related_name="closings")
    summary = models.JSONField()
    closing_journal = models.ForeignKey(
        "accounting.JournalEntry", on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )
    retained_earnings_account = models.ForeignKey("accounting.Account", on_delete=models.PROTECT, related_name="+")
    next_fiscal_year = models.ForeignKey(
        FiscalYear, on_delete=models.PROTECT, null=True, blank=True, related_name="carried_from"
    )
    closed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    reopened_at = models.DateTimeField(null=True, blank=True)
    reversal_journal = models.ForeignKey(
        "accounting.JournalEntry", on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )
