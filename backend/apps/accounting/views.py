from decimal import Decimal

from django.db import transaction
from django.db.models import Count, DecimalField, OuterRef, Q, Subquery, Sum, Value
from django.db.models.functions import Coalesce
from django.utils import timezone
from drf_spectacular.utils import extend_schema
from rest_framework import mixins, serializers, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from apps.audit.services import record_event
from apps.calendar_utils.fields import parse_date_input
from apps.calendar_utils.ranges import resolve_date_range
from apps.core.document_views import DocumentViewSet
from apps.core.exceptions import BusinessRuleError
from apps.core.export import export_response
from apps.core.permissions import HasModulePermission
from apps.core.serializers import ReasonSerializer
from apps.core.viewsets import OrganizationModelViewSet, OrganizationScopedMixin

from .ledgers import account_ledger
from .models import Account, BankReconciliation, JournalEntry, JournalLine, JournalSource, JournalStatus
from .serializers import (
    AccountSerializer,
    JournalEntrySerializer,
    JournalLineSerializer,
    JournalListSerializer,
    ReconciliationSerializer,
)
from .services import post_draft_journal, posted_lines, reverse_journal


def _balance_annotation(end=None):
    lines = JournalLine.objects.filter(account=OuterRef("pk"), entry__status__in=[JournalStatus.POSTED, JournalStatus.REVERSED])
    if end:
        lines = lines.filter(entry__date__lte=end)
    sub = lines.values("account").annotate(net=Sum("debit") - Sum("credit")).values("net")
    out = DecimalField(max_digits=18, decimal_places=2)
    return Coalesce(Subquery(sub, output_field=out), Value(Decimal("0")), output_field=out)


class AccountViewSet(OrganizationModelViewSet):
    queryset = Account.objects.select_related("parent")
    serializer_class = AccountSerializer
    permission_module = "accounting"
    permission_map = {"list": None, "retrieve": "accounting.view", "ledger": "accounting.view",
                      "cash_bank": ("accounting.view", "reports.financial"), "export": "accounting.view"}
    audit_entity = "account"
    pagination_class = None
    search_fields = ["code", "name"]
    filterset_fields = {"account_type": ["exact"], "is_group": ["exact"], "is_cash": ["exact"], "is_bank": ["exact"],
                        "is_active": ["exact"], "system_key": ["exact"]}
    ordering = ["code"]

    def get_queryset(self):
        qs = super().get_queryset()
        if "accounting.view" in self.request.perms or "reports.financial" in self.request.perms:
            as_of = parse_date_input(self.request.query_params.get("as_of"), self.request.query_params.get("as_of_bs"), "as_of")
            qs = qs.annotate(balance=_balance_annotation(as_of))
        return qs

    def perform_create(self, serializer):
        with transaction.atomic():
            account = serializer.save(organization=self.request.organization)
            record_event(self.request, "created", "account", account)

    def perform_destroy(self, instance):
        if instance.system_key:
            raise BusinessRuleError("System accounts cannot be deleted.")
        if instance.lines.exists() or instance.children.exists():
            raise BusinessRuleError("Accounts with postings or sub-accounts cannot be deleted; deactivate them instead.")
        record_event(self.request, "deleted", "account", instance)
        instance.delete()

    @action(detail=True, methods=["get"])
    def ledger(self, request, pk=None):
        account = self.get_object()
        date_range = resolve_date_range(request.query_params, request.organization)
        data = account_ledger(account, date_range.start, date_range.end)
        data["range"] = date_range.as_dict()
        data["account"] = {"id": account.pk, "code": account.code, "name": account.name, "type": account.account_type,
                           "is_debit_normal": account.is_debit_normal}
        fmt = request.query_params.get("export")
        if fmt in ("csv", "xlsx"):
            columns = [("date", "Date", "date"), ("journal_number", "Voucher", "text"), ("source_number", "Document", "text"),
                       ("narration", "Particulars", "text"), ("debit", "Debit", "money"), ("credit", "Credit", "money"),
                       ("balance", "Balance", "money")]
            return export_response(data["rows"], columns, f"ledger-{account.code}", fmt, title=str(account),
                                   meta={"Opening": data["opening_balance"], "Closing": data["closing_balance"]})
        return Response(data)

    @action(detail=False, methods=["get"], url_path="cash-bank")
    def cash_bank(self, request):
        """Cash and bank accounts with balance and period movement."""
        date_range = resolve_date_range(request.query_params, request.organization)
        rows = []
        for account in Account.objects.filter(organization=request.organization, is_group=False).filter(
                Q(is_cash=True) | Q(is_bank=True)).order_by("code"):
            data = account_ledger(account, date_range.start, date_range.end)
            rows.append({"id": account.pk, "code": account.code, "name": account.name, "is_cash": account.is_cash,
                         "is_bank": account.is_bank, "bank_name": account.bank_name,
                         "opening_balance": data["opening_balance"], "receipts": data["total_debit"],
                         "payments": data["total_credit"], "closing_balance": data["closing_balance"],
                         "unreconciled": posted_lines(request.organization).filter(account=account, cleared_date__isnull=True).count()
                         if account.is_bank else None})
        return Response({"range": date_range.as_dict(), "accounts": rows})


class JournalViewSet(DocumentViewSet):
    queryset = JournalEntry.objects.select_related("fiscal_year", "period", "posted_by", "created_by", "reversal_of") \
        .prefetch_related("lines__account", "lines__customer", "lines__supplier")
    serializer_class = JournalEntrySerializer
    permission_module = "accounting"
    permission_map = {"post_document": "accounting.post", "reverse": "accounting.reverse", "pdf": "accounting.view",
                      "timeline": "accounting.view"}
    audit_entity = "journalentry"
    entity_type = "journalentry"
    pdf_template = "documents/journal_voucher.html"
    pdf_title = "Journal Voucher"
    date_field = "date"
    search_fields = ["number", "narration", "source_number"]
    filterset_fields = {"status": ["exact"], "source": ["exact", "in"], "fiscal_year": ["exact"], "period": ["exact"],
                        "lines__account": ["exact"]}
    ordering_fields = ["date", "number", "total_debit", "created_at"]
    ordering = ["-date", "-id"]

    def get_serializer_class(self):
        return JournalListSerializer if self.action == "list" else JournalEntrySerializer

    def get_queryset(self):
        return super().get_queryset().distinct()

    def perform_create(self, serializer):
        with transaction.atomic():
            entry = serializer.save(organization=self.request.organization, created_by=self.request.user)
            record_event(self.request, "created", "journalentry", entry)

    @extend_schema(request=None)
    @action(detail=True, methods=["post"], url_path="post")
    def post_document(self, request, pk=None):
        with transaction.atomic():
            entry = post_draft_journal(self.get_object(), request.user)
            record_event(request, "journal.posted", "journalentry", entry, new={"total": str(entry.total_debit)})
        return self.fresh(entry)

    @extend_schema(request=ReasonSerializer)
    @action(detail=True, methods=["post"])
    def reverse(self, request, pk=None):
        data = ReasonSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        entry = self.get_object()
        if entry.source not in (JournalSource.MANUAL, JournalSource.OPENING):
            raise BusinessRuleError("System journals are reversed by reversing their source document.")
        date = parse_date_input(request.data.get("date"), request.data.get("date_bs"), "date") or max(timezone.localdate(), entry.date)
        with transaction.atomic():
            reversal = reverse_journal(entry, date=date, user=request.user, reason=data.validated_data["reason"])
            record_event(request, "journal.reversed", "journalentry", entry, reason=data.validated_data["reason"],
                         new={"reversal": reversal.number})
        return self.fresh(reversal)


class ReconcileSerializer(serializers.Serializer):
    account = serializers.IntegerField()
    statement_date = serializers.DateField(required=False)
    statement_date_bs = serializers.CharField(required=False)
    statement_balance = serializers.DecimalField(max_digits=18, decimal_places=2)
    cleared_lines = serializers.ListField(child=serializers.IntegerField())
    notes = serializers.CharField(required=False, allow_blank=True, default="")


class BankReconciliationViewSet(OrganizationScopedMixin, mixins.ListModelMixin, mixins.RetrieveModelMixin,
                                viewsets.GenericViewSet):
    queryset = BankReconciliation.objects.select_related("account", "created_by").annotate(cleared_count=Count("lines"))
    serializer_class = ReconciliationSerializer
    permission_module = "accounting"
    permission_map = {"unreconciled": "accounting.view", "reconcile": "accounting.manage"}
    filterset_fields = ["account"]
    ordering = ["-statement_date", "-id"]

    @action(detail=False, methods=["get"])
    def unreconciled(self, request):
        account = Account.objects.filter(organization=request.organization, pk=request.query_params.get("account") or 0,
                                         is_bank=True).first()
        if account is None:
            raise ValidationError({"account": ["Choose a bank account."]})
        end = parse_date_input(request.query_params.get("statement_date"), request.query_params.get("statement_date_bs"),
                               "statement_date") or timezone.localdate()
        lines = posted_lines(request.organization).filter(account=account, cleared_date__isnull=True, entry__date__lte=end) \
            .select_related("entry").order_by("entry__date", "id")
        book = posted_lines(request.organization).filter(account=account, entry__date__lte=end).aggregate(
            d=Sum("debit"), c=Sum("credit"))
        cleared = posted_lines(request.organization).filter(account=account, cleared_date__isnull=False).aggregate(
            d=Sum("debit"), c=Sum("credit"))
        from apps.calendar_utils.fields import bs_or_none

        return Response({
            "account": {"id": account.pk, "name": str(account)},
            "statement_date": end,
            "book_balance": (book["d"] or 0) - (book["c"] or 0),
            "cleared_balance": (cleared["d"] or 0) - (cleared["c"] or 0),
            "lines": [{"id": l.pk, "date": l.entry.date, "date_bs": bs_or_none(l.entry.date), "journal_number": l.entry.number,
                       "source_number": l.entry.source_number, "narration": l.description or l.entry.narration,
                       "deposit": l.debit, "withdrawal": l.credit} for l in lines],
        })

    @extend_schema(request=ReconcileSerializer)
    @action(detail=False, methods=["post"])
    def reconcile(self, request):
        data = ReconcileSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        d = data.validated_data
        statement_date = parse_date_input(d.get("statement_date"), d.get("statement_date_bs"), "statement_date")
        if statement_date is None:
            raise ValidationError({"statement_date": ["Enter the statement date."]})
        account = Account.objects.filter(organization=request.organization, pk=d["account"], is_bank=True).first()
        if account is None:
            raise ValidationError({"account": ["Choose a bank account."]})
        with transaction.atomic():
            lines = list(posted_lines(request.organization).select_for_update().filter(
                pk__in=d["cleared_lines"], account=account, cleared_date__isnull=True, entry__date__lte=statement_date))
            if len(lines) != len(set(d["cleared_lines"])):
                raise ValidationError({"cleared_lines": ["Some lines are not open items of this account up to the statement date."]})
            book = posted_lines(request.organization).filter(account=account, entry__date__lte=statement_date).aggregate(
                d=Sum("debit"), c=Sum("credit"))
            book_balance = (book["d"] or 0) - (book["c"] or 0)
            rec = BankReconciliation.objects.create(
                organization=request.organization, account=account, statement_date=statement_date,
                statement_balance=d["statement_balance"], book_balance=book_balance, cleared_balance=0, difference=0,
                notes=d["notes"], created_by=request.user,
            )
            for line in lines:
                line.cleared_date = statement_date
                line.reconciliation = rec
                line.save(update_fields=["cleared_date", "reconciliation"])
            cleared = posted_lines(request.organization).filter(account=account, cleared_date__isnull=False,
                                                                cleared_date__lte=statement_date).aggregate(d=Sum("debit"), c=Sum("credit"))
            rec.cleared_balance = (cleared["d"] or 0) - (cleared["c"] or 0)
            rec.difference = rec.statement_balance - rec.cleared_balance
            rec.save()
            record_event(request, "bank.reconciled", "account", account,
                         new={"statement_date": statement_date.isoformat(), "cleared": len(lines), "difference": str(rec.difference)})
        return Response(ReconciliationSerializer(BankReconciliation.objects.annotate(cleared_count=Count("lines")).get(pk=rec.pk)).data)
