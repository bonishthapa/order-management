from rest_framework.filters import BaseFilterBackend

from apps.calendar_utils.ranges import resolve_date_range


class DateRangeFilterBackend(BaseFilterBackend):
    """Applies AD/BS/fiscal-year date filters to ``view.date_field`` (see calendar_utils.ranges)."""

    def filter_queryset(self, request, queryset, view):
        field = getattr(view, "date_field", None)
        if not field:
            return queryset
        date_range = resolve_date_range(request.query_params, request.organization)
        return queryset.filter(**date_range.filter_kwargs(field))

    def get_schema_operation_parameters(self, view):
        if not getattr(view, "date_field", None):
            return []
        names = ["date_from", "date_to", "date_from_bs", "date_to_bs", "fiscal_year", "period"]
        return [{"name": n, "required": False, "in": "query", "schema": {"type": "string"}} for n in names]
