import datetime as dt

from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .bs import BSDateError, ad_to_bs, bs_month_bounds, bs_year_range, days_in_bs_month, month_names, parse_bs, supported_range


@extend_schema(parameters=[OpenApiParameter("ad", str), OpenApiParameter("bs", str)], tags=["calendar"])
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def convert(request):
    """Convert one date. Exactly one of ``ad`` or ``bs`` (YYYY-MM-DD)."""
    ad_text, bs_text = request.query_params.get("ad"), request.query_params.get("bs")
    try:
        if ad_text:
            ad = dt.date.fromisoformat(ad_text)
            bs = ad_to_bs(ad)
        elif bs_text:
            bs = parse_bs(bs_text)
            ad = bs.to_ad()
        else:
            raise ValidationError({"ad": ["Provide ad or bs."]})
    except (BSDateError, ValueError) as exc:
        raise ValidationError({"bs" if bs_text else "ad": [str(exc)]})
    return Response({"ad": ad.isoformat(), "bs": bs.isoformat(), "bs_month_name": bs.month_name, "weekday": ad.strftime("%A")})


@extend_schema(tags=["calendar"])
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def meta(request):
    start, end = supported_range()
    min_year, max_year = bs_year_range()
    return Response({
        "ad_min": start.isoformat(), "ad_max": end.isoformat(), "bs_min_year": min_year, "bs_max_year": max_year,
        "month_names": month_names(), "source": "nepali-datetime 1.0.8.5 calendar data (MIT)",
    })


@extend_schema(parameters=[OpenApiParameter("year", int), OpenApiParameter("month", int)], tags=["calendar"])
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def bs_month(request):
    try:
        year, month = int(request.query_params["year"]), int(request.query_params["month"])
        start, end = bs_month_bounds(year, month)
    except (KeyError, ValueError, BSDateError) as exc:
        raise ValidationError({"month": [str(exc)]})
    return Response({"year": year, "month": month, "name": month_names()[month - 1], "days": days_in_bs_month(year, month),
                     "ad_start": start.isoformat(), "ad_end": end.isoformat(), "first_weekday": start.isoweekday() % 7})
