"""Shared endpoints for customers and suppliers: ledger, statement, aging, opening balance, export."""
from django.db.models import DecimalField, OuterRef, Subquery, Sum, Value
from django.db.models.functions import Coalesce
from django.utils import timezone
from drf_spectacular.utils import extend_schema
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.accounting.models import JournalLine, JournalStatus, SystemAccount
from apps.calendar_utils.ranges import resolve_date_range
from apps.core.export import export_response
from apps.core.pdf import pdf_response, render_pdf


def balance_subquery(party_field, system_key, credit_normal=False):
    lines = (
        JournalLine.objects.filter(**{party_field: OuterRef("pk")}, account__system_key=system_key,
                                   entry__status__in=[JournalStatus.POSTED, JournalStatus.REVERSED])
        .values(party_field)
        .annotate(net=Sum("credit") - Sum("debit") if credit_normal else Sum("debit") - Sum("credit"))
        .values("net")
    )
    return Coalesce(Subquery(lines, output_field=DecimalField(max_digits=18, decimal_places=2)), Value(0),
                    output_field=DecimalField(max_digits=18, decimal_places=2))


class PartyActionsMixin:
    party_kind = None  # "customer" | "supplier"
    export_columns = []

    def _ledger(self, party, start, end):
        from apps.accounting.ledgers import customer_ledger, supplier_ledger

        return (customer_ledger if self.party_kind == "customer" else supplier_ledger)(party, start, end)

    @action(detail=True, methods=["get"])
    def ledger(self, request, pk=None):
        party = self.get_object()
        date_range = resolve_date_range(request.query_params, request.organization)
        data = self._ledger(party, date_range.start, date_range.end)
        data["range"] = date_range.as_dict()
        fmt = request.query_params.get("export")
        if fmt in ("csv", "xlsx"):
            columns = [("date", "Date", "date"), ("journal_number", "Voucher", "text"), ("source_number", "Document", "text"),
                       ("narration", "Particulars", "text"), ("debit", "Debit", "money"), ("credit", "Credit", "money"),
                       ("balance", "Balance", "money")]
            return export_response(data["rows"], columns, f"{party.code}-ledger", fmt, title=f"Ledger – {party.name}",
                                   meta={"Opening balance": data["opening_balance"], "Closing balance": data["closing_balance"]})
        return Response(data)

    @action(detail=True, methods=["get"])
    def statement(self, request, pk=None):
        """Printable statement of account (PDF) with ledger and open items."""
        from apps.accounting.ledgers import payable_aging, receivable_aging

        party = self.get_object()
        date_range = resolve_date_range(request.query_params, request.organization)
        data = self._ledger(party, date_range.start, date_range.end)
        as_of = date_range.end or timezone.localdate()
        aging_fn = receivable_aging if self.party_kind == "customer" else payable_aging
        aging = aging_fn(request.organization, as_of, party)
        pdf = render_pdf("documents/statement.html", {
            "organization": request.organization, "party": party, "party_kind": self.party_kind,
            "ledger": data, "range": date_range, "aging": aging, "as_of": as_of,
        }, request)
        from apps.audit.services import record_event

        record_event(request, "statement.printed", self.party_kind, party)
        return pdf_response(pdf, f"statement-{party.code}.pdf")

    @action(detail=True, methods=["get"])
    def aging(self, request, pk=None):
        from apps.accounting.ledgers import payable_aging, receivable_aging
        from apps.calendar_utils.fields import parse_date_input

        party = self.get_object()
        as_of = parse_date_input(request.query_params.get("as_of"), request.query_params.get("as_of_bs"), "as_of") or timezone.localdate()
        aging_fn = receivable_aging if self.party_kind == "customer" else payable_aging
        return Response(aging_fn(request.organization, as_of, party))

    @extend_schema(request=None)
    @action(detail=False, methods=["get"])
    def export(self, request):
        fmt = request.query_params.get("export", "csv")
        rows = self.filter_queryset(self.get_queryset())
        return export_response(rows, self.export_columns, f"{self.party_kind}s", fmt)
