from drf_spectacular.utils import extend_schema
from rest_framework.decorators import action

from apps.core.document_views import DocumentViewSet
from apps.core.serializers import ReasonSerializer
from apps.core.viewsets import OrganizationModelViewSet

from . import services
from .models import Expense, ExpenseCategory
from .serializers import ExpenseCategorySerializer, ExpenseSerializer


class ExpenseCategoryViewSet(OrganizationModelViewSet):
    queryset = ExpenseCategory.objects.select_related("account")
    serializer_class = ExpenseCategorySerializer
    permission_module = "expenses"
    permission_map = {"list": None, "retrieve": None, "create": "accounting.manage", "update": "accounting.manage",
                      "partial_update": "accounting.manage", "destroy": "accounting.manage"}
    pagination_class = None

    def perform_create(self, serializer):
        serializer.save(organization=self.request.organization)


class ExpenseViewSet(DocumentViewSet):
    queryset = Expense.objects.select_related("category", "supplier", "fiscal_year", "payment_method", "paid_from_account", "created_by",
                                              "approved_by", "journal")
    serializer_class = ExpenseSerializer
    permission_module = "expenses"
    permission_map = {"submit": "expenses.manage", "approve": "expenses.approve", "reject": "expenses.approve",
                      "reverse": "accounting.reverse"}
    audit_entity = "expense"
    entity_type = "expense"
    pdf_template = "documents/expense_voucher.html"
    pdf_title = "Expense Voucher"
    date_field = "date"
    search_fields = ["number", "payee", "description", "reference", "category__name"]
    filterset_fields = {"status": ["exact", "in"], "category": ["exact"], "paid_from_account": ["exact"], "supplier": ["exact"]}
    ordering_fields = ["date", "number", "total", "created_at"]
    ordering = ["-date", "-id"]

    def get_queryset(self):
        from django.db.models import Count, IntegerField, OuterRef, Subquery, Value
        from django.db.models.functions import Coalesce

        from apps.core.models import Attachment

        attachments = Attachment.objects.filter(entity_type="expense", entity_id=OuterRef("pk")).values("entity_id") \
            .annotate(c=Count("id")).values("c")
        return super().get_queryset().annotate(attachment_count=Coalesce(Subquery(attachments, output_field=IntegerField()), Value(0)))

    @extend_schema(request=None)
    @action(detail=True, methods=["post"])
    def submit(self, request, pk=None):
        return self.fresh(services.submit_expense(self.get_object(), request.user, request=request))

    @extend_schema(request=None)
    @action(detail=True, methods=["post"])
    def approve(self, request, pk=None):
        return self.fresh(services.approve_expense(self.get_object(), request.user, request=request))

    @extend_schema(request=ReasonSerializer)
    @action(detail=True, methods=["post"])
    def reject(self, request, pk=None):
        data = ReasonSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        return self.fresh(services.reject_expense(self.get_object(), request.user, data.validated_data["reason"], request=request))

    @extend_schema(request=ReasonSerializer)
    @action(detail=True, methods=["post"])
    def reverse(self, request, pk=None):
        data = ReasonSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        return self.fresh(services.reverse_expense(self.get_object(), request.user, data.validated_data["reason"], request=request))
