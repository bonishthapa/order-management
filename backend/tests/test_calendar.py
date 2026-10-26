import datetime as dt
import hashlib
import json
from pathlib import Path

import nepali_datetime
import pytest
from rest_framework import serializers

from apps.calendar_utils.bs import (
    BSDate,
    BSDateError,
    ad_to_bs,
    bs_month_bounds,
    bs_to_ad,
    days_in_bs_month,
    parse_bs,
    supported_range,
)
from apps.calendar_utils.fields import DualDateSerializerMixin, parse_date_input
from apps.calendar_utils.ranges import resolve_date_range

KNOWN = [
    # (AD, BS) pairs checked against the published Nepali calendar.
    (dt.date(2026, 4, 14), "2083-01-01"),  # Nepali New Year 2083
    (dt.date(2025, 4, 14), "2082-01-01"),
    (dt.date(2024, 4, 13), "2081-01-01"),
    (dt.date(2026, 7, 17), "2083-04-01"),  # start of fiscal year 2083/84
    (dt.date(2025, 7, 17), "2082-04-01"),
    (dt.date(2026, 7, 16), "2083-03-32"),  # Ashadh 2083 has 32 days
    (dt.date(1943, 4, 14), "2000-01-01"),
    (dt.date(2026, 10, 26), "2083-07-09"),
]


@pytest.mark.parametrize("ad,bs", KNOWN)
def test_known_dates(ad, bs):
    assert ad_to_bs(ad).isoformat() == bs
    assert parse_bs(bs).to_ad() == ad


def test_every_supported_day_matches_reference_library_and_round_trips():
    """Exhaustive check over the full supported range (≈46,000 days) against nepali-datetime."""
    start, end = supported_range()
    day = start
    previous = None
    while day <= end:
        bs = ad_to_bs(day)
        ref = nepali_datetime.date.from_datetime_date(day)
        assert (bs.year, bs.month, bs.day) == (ref.year, ref.month, ref.day), day
        assert bs_to_ad(bs) == day
        if previous is not None:
            # Consecutive AD days map to consecutive BS days with no gaps or repeats.
            assert bs > previous
        previous = bs
        day += dt.timedelta(days=1)


def test_month_lengths_vary_and_are_not_fixed():
    lengths = {days_in_bs_month(2083, m) for m in range(1, 13)}
    assert lengths <= {29, 30, 31, 32}
    assert len(lengths) > 1
    assert sum(days_in_bs_month(2083, m) for m in range(1, 13)) in (365, 366)


@pytest.mark.parametrize("text", ["2083-02-33", "2083-13-01", "2083-00-10", "2083-01-00", "1900-01-01", "2200-01-01", "abc", ""])
def test_invalid_bs_dates_rejected(text):
    with pytest.raises(BSDateError):
        parse_bs(text)


def test_invalid_day_for_specific_month():
    length = days_in_bs_month(2083, 9)
    BSDate(2083, 9, length)
    with pytest.raises(BSDateError):
        BSDate(2083, 9, length + 1)


def test_out_of_range_ad():
    start, end = supported_range()
    with pytest.raises(BSDateError):
        ad_to_bs(start - dt.timedelta(days=1))
    with pytest.raises(BSDateError):
        ad_to_bs(end + dt.timedelta(days=1))


def test_month_bounds_are_contiguous():
    for month in range(1, 12):
        _, end = bs_month_bounds(2083, month)
        start_next, _ = bs_month_bounds(2083, month + 1)
        assert start_next == end + dt.timedelta(days=1)


def test_leap_year_boundaries_ad():
    # 29 Feb 2028 exists in AD and converts both ways.
    assert bs_to_ad(ad_to_bs(dt.date(2028, 2, 29))) == dt.date(2028, 2, 29)


def test_datetime_rejected_to_prevent_timezone_day_shift():
    with pytest.raises(TypeError):
        ad_to_bs(dt.datetime(2026, 4, 14, 23, 30))


def test_parse_date_input_variants():
    assert parse_date_input("2026-04-14", None) == dt.date(2026, 4, 14)
    assert parse_date_input(None, "2083-01-01") == dt.date(2026, 4, 14)
    assert parse_date_input("2026-04-14", "2083-01-01") == dt.date(2026, 4, 14)
    with pytest.raises(serializers.ValidationError):
        parse_date_input("2026-04-15", "2083-01-01")
    with pytest.raises(serializers.ValidationError):
        parse_date_input(None, "2083-02-40")


def test_shared_dataset_is_identical_everywhere():
    root = Path(__file__).resolve().parents[2]
    backend_copy = Path(__file__).resolve().parents[1] / "apps" / "calendar_utils" / "data" / "bs-calendar.json"
    copies = [backend_copy, root / "shared" / "bs-calendar.json", root / "frontend" / "src" / "calendar" / "bs-calendar.json"]
    digests = {hashlib.sha256(p.read_bytes()).hexdigest() for p in copies if p.exists()}
    assert len(digests) == 1
    data = json.loads(backend_copy.read_text())
    assert data["minYear"] <= 2000 and data["maxYear"] >= 2090


def test_fixture_file_matches_backend():
    """shared/bs-fixtures.json is also consumed by the frontend test-suite."""
    root = Path(__file__).resolve().parents[2]
    fixture = root / "shared" / "bs-fixtures.json"
    if not fixture.exists():
        pytest.skip("fixtures not generated")
    for item in json.loads(fixture.read_text()):
        assert ad_to_bs(dt.date.fromisoformat(item["ad"])).isoformat() == item["bs"]


class _Sample(DualDateSerializerMixin, serializers.ModelSerializer):
    class Meta:
        from apps.accounting.models import JournalEntry

        model = JournalEntry
        fields = ["date"]


def test_serializer_accepts_bs_and_returns_both(db):
    s = _Sample(data={"date_bs": "2083-04-01"})
    assert s.is_valid(), s.errors
    assert s.validated_data["date"] == dt.date(2026, 7, 17)

    class Obj:
        date = dt.date(2026, 4, 14)

    out = _Sample(Obj()).data
    assert out == {"date": "2026-04-14", "date_bs": "2083-01-01"}


def test_serializer_rejects_invalid_bs(db):
    s = _Sample(data={"date_bs": "2083-01-32"})
    assert not s.is_valid()
    assert "date_bs" in s.errors


def test_range_from_bs_is_inclusive(org):
    last = days_in_bs_month(2083, 4)
    rng = resolve_date_range({"date_from_bs": "2083-04-01", "date_to_bs": f"2083-04-{last}"}, org)
    assert rng.start == dt.date(2026, 7, 17)
    assert rng.end == bs_month_bounds(2083, 4)[1]
    kwargs = rng.filter_kwargs("date")
    assert kwargs == {"date__gte": rng.start, "date__lte": rng.end}


def test_datetime_range_uses_timezone_aware_bounds(org):
    rng = resolve_date_range({"date_from": "2026-04-14", "date_to": "2026-04-14"}, org)
    kwargs = rng.datetime_filter_kwargs("created_at", "Asia/Kathmandu")
    assert kwargs["created_at__gte"].utcoffset() == dt.timedelta(hours=5, minutes=45)
    assert kwargs["created_at__lt"] - kwargs["created_at__gte"] == dt.timedelta(days=1)


def test_reversed_range_rejected(org):
    with pytest.raises(serializers.ValidationError):
        resolve_date_range({"date_from": "2026-05-01", "date_to": "2026-04-01"}, org)


def test_convert_endpoint(api):
    r = api.get("/api/v1/calendar/convert/", {"bs": "2083-01-01"})
    assert r.status_code == 200 and r.json()["ad"] == "2026-04-14"
    r = api.get("/api/v1/calendar/convert/", {"ad": "2026-07-17"})
    assert r.json()["bs"] == "2083-04-01"
    r = api.get("/api/v1/calendar/convert/", {"bs": "2083-03-33"})
    assert r.status_code == 400
