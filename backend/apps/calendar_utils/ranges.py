"""Resolution of report/list date filters into canonical AD ranges.

Accepted query parameters (all optional, all inclusive):

* ``date_from`` / ``date_to``           – AD dates, ``YYYY-MM-DD``
* ``date_from_bs`` / ``date_to_bs``     – BS dates, converted on the server
* ``fiscal_year``                       – fiscal year id, or ``current`` / ``previous``
* ``period``                            – accounting period id

Explicit dates narrow a fiscal year/period range rather than replacing it. Date-only fields are
filtered with ``__gte start`` and ``__lte end``. Timestamp fields use timezone-aware
``[start 00:00, end+1 00:00)`` bounds in the organisation timezone, never 23:59:59 tricks.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from zoneinfo import ZoneInfo

from rest_framework.exceptions import ValidationError

from .fields import parse_date_input


@dataclass(frozen=True)
class DateRange:
    start: dt.date | None = None
    end: dt.date | None = None
    fiscal_year: object | None = None

    def filter_kwargs(self, field: str) -> dict:
        kwargs = {}
        if self.start:
            kwargs[f"{field}__gte"] = self.start
        if self.end:
            kwargs[f"{field}__lte"] = self.end
        return kwargs

    def datetime_filter_kwargs(self, field: str, tz_name: str) -> dict:
        tz = ZoneInfo(tz_name)
        kwargs = {}
        if self.start:
            kwargs[f"{field}__gte"] = dt.datetime.combine(self.start, dt.time.min, tzinfo=tz)
        if self.end:
            kwargs[f"{field}__lt"] = dt.datetime.combine(self.end + dt.timedelta(days=1), dt.time.min, tzinfo=tz)
        return kwargs

    def as_dict(self):
        from .fields import bs_or_none

        return {
            "start": self.start.isoformat() if self.start else None,
            "end": self.end.isoformat() if self.end else None,
            "start_bs": bs_or_none(self.start),
            "end_bs": bs_or_none(self.end),
            "fiscal_year": getattr(self.fiscal_year, "id", None),
            "fiscal_year_name": getattr(self.fiscal_year, "name", None),
        }


def resolve_date_range(params, organization=None, *, default_to_current_fy=False) -> DateRange:
    start = parse_date_input(params.get("date_from"), params.get("date_from_bs"), "date_from")
    end = parse_date_input(params.get("date_to"), params.get("date_to_bs"), "date_to")
    fiscal_year = None
    fy_param = params.get("fiscal_year")
    period_param = params.get("period")

    if organization is not None and (fy_param or period_param or (default_to_current_fy and not (start or end))):
        from apps.fiscal_years.models import AccountingPeriod, FiscalYear

        if period_param:
            try:
                period = AccountingPeriod.objects.select_related("fiscal_year").get(
                    pk=int(period_param), fiscal_year__organization=organization
                )
            except (ValueError, AccountingPeriod.DoesNotExist):
                raise ValidationError({"period": "Unknown accounting period."})
            fiscal_year = period.fiscal_year
            fy_start, fy_end = period.start_date, period.end_date
        else:
            fiscal_year = FiscalYear.resolve(organization, fy_param or "current")
            if fiscal_year is None:
                if fy_param:
                    raise ValidationError({"fiscal_year": "Unknown fiscal year."})
                fy_start = fy_end = None
            else:
                fy_start, fy_end = fiscal_year.start_date, fiscal_year.end_date
        if fy_start:
            start = max(start, fy_start) if start else fy_start
        if fy_end:
            end = min(end, fy_end) if end else fy_end

    if start and end and start > end:
        raise ValidationError({"date_to": "End date must be on or after the start date."})
    return DateRange(start, end, fiscal_year)
