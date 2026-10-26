"""Bikram Sambat <-> Gregorian conversion.

The month-length table lives in ``data/bs-calendar.json`` and is byte-identical to
``shared/bs-calendar.json`` and to the copy bundled with the frontend, so both sides of the
application convert dates with exactly the same data. Conversion is a day count from a
known anchor (1975-01-01 BS = 1918-04-13 AD); there is no year offset or fixed month length.

See docs/calendar-and-date-rules.md for the data source, licence and supported range.
"""
from __future__ import annotations

import datetime as dt
import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

DATA_PATH = Path(__file__).resolve().parent / "data" / "bs-calendar.json"


class BSDateError(ValueError):
    """Raised for an invalid or out-of-range BS date."""


@lru_cache(maxsize=1)
def _calendar():
    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    months = {int(year): lengths for year, lengths in data["months"].items()}
    min_year, max_year = data["minYear"], data["maxYear"]
    # Cumulative days before each BS year, counted from 1 Baisakh of min_year.
    year_offsets = {}
    total = 0
    for year in range(min_year, max_year + 1):
        year_offsets[year] = total
        total += sum(months[year])
    anchor_ad = dt.date(*data["reference"]["ad"])
    return {
        "months": months,
        "min_year": min_year,
        "max_year": max_year,
        "year_offsets": year_offsets,
        "total_days": total,
        "anchor_ad": anchor_ad,
        "month_names": data["monthNames"],
        "month_names_ne": data["monthNamesNe"],
    }


@dataclass(frozen=True, order=True)
class BSDate:
    year: int
    month: int
    day: int

    def __post_init__(self):
        validate_bs(self.year, self.month, self.day)

    def isoformat(self) -> str:
        return f"{self.year:04d}-{self.month:02d}-{self.day:02d}"

    __str__ = isoformat

    def to_ad(self) -> dt.date:
        return bs_to_ad(self)

    @property
    def month_name(self) -> str:
        return _calendar()["month_names"][self.month - 1]


def supported_range() -> tuple[dt.date, dt.date]:
    cal = _calendar()
    start = cal["anchor_ad"]
    return start, start + dt.timedelta(days=cal["total_days"] - 1)


def bs_year_range() -> tuple[int, int]:
    cal = _calendar()
    return cal["min_year"], cal["max_year"]


def days_in_bs_month(year: int, month: int) -> int:
    cal = _calendar()
    if year not in cal["months"]:
        raise BSDateError(f"BS year {year} is outside the supported range {cal['min_year']}-{cal['max_year']}.")
    if not 1 <= month <= 12:
        raise BSDateError(f"BS month must be between 1 and 12, got {month}.")
    return cal["months"][year][month - 1]


def validate_bs(year: int, month: int, day: int) -> None:
    length = days_in_bs_month(year, month)
    if not 1 <= day <= length:
        raise BSDateError(f"{year:04d}-{month:02d} BS has {length} days; day {day} is invalid.")


def bs_to_ad(value: BSDate | tuple[int, int, int]) -> dt.date:
    year, month, day = (value.year, value.month, value.day) if isinstance(value, BSDate) else value
    validate_bs(year, month, day)
    cal = _calendar()
    days = cal["year_offsets"][year] + sum(cal["months"][year][: month - 1]) + (day - 1)
    return cal["anchor_ad"] + dt.timedelta(days=days)


def ad_to_bs(value: dt.date) -> BSDate:
    if isinstance(value, dt.datetime):
        raise TypeError("ad_to_bs expects a date; convert datetimes to the business timezone first.")
    cal = _calendar()
    offset = (value - cal["anchor_ad"]).days
    if offset < 0 or offset >= cal["total_days"]:
        start, end = supported_range()
        raise BSDateError(f"{value.isoformat()} is outside the supported range {start} to {end}.")
    # Find the year by walking the cumulative table (126 entries; fast enough and obviously correct).
    year = cal["min_year"]
    for candidate in range(cal["min_year"], cal["max_year"] + 1):
        if cal["year_offsets"][candidate] > offset:
            break
        year = candidate
    remaining = offset - cal["year_offsets"][year]
    for month_index, length in enumerate(cal["months"][year]):
        if remaining < length:
            return BSDate(year, month_index + 1, remaining + 1)
        remaining -= length
    raise AssertionError("unreachable: offset exceeded year length")


_BS_PATTERN = re.compile(r"^\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*$")


def parse_bs(text: str) -> BSDate:
    """Parse ``YYYY-MM-DD`` (also accepts ``/`` or ``.`` separators)."""
    match = _BS_PATTERN.match(text or "")
    if not match:
        raise BSDateError(f"'{text}' is not a BS date in YYYY-MM-DD format.")
    return BSDate(*(int(part) for part in match.groups()))


def bs_month_bounds(year: int, month: int) -> tuple[dt.date, dt.date]:
    start = bs_to_ad((year, month, 1))
    return start, start + dt.timedelta(days=days_in_bs_month(year, month) - 1)


def format_bs(value: dt.date | None) -> str:
    return ad_to_bs(value).isoformat() if value else ""


def month_names() -> list[str]:
    return list(_calendar()["month_names"])
