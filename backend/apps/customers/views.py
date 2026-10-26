from django.db.models import Count, Max, Q
from drf_spectacular.utils import extend_schema
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.accounting.models import SystemAccount
from apps.accounting.opening import post_customer_opening_balance
from apps.accounting.services import party_balance
from apps.core.party_views import PartyActionsMixin, balance_subquery
from apps.core.viewsets import OrganizationModelViewSet

from .models import Customer, CustomerCategory
from .serializers import CustomerCategorySerializer, CustomerSerializer, OpeningBalanceSerializer


class CustomerCategoryViewSet(OrganizationModelViewSet):
    queryset = CustomerCategory.objects.all()
    serializer_class = CustomerCategorySerializer
    permission_module = "customers"
    permission_map = {"list": None, "retrieve": None}
    pagination_class = None

    def perform_create(self, serializer):
        serializer.save(organization=self.request.organization)


class CustomerViewSet(PartyActionsMixin, OrganizationModelViewSet):
    queryset = Customer.objects.select_related("category")
    serializer_class = CustomerSerializer
    permission_module = "customers"
    permission_map = {"opening_balance": "customers.manage", "export": "customers.view"}
    audit_entity = "customer"
    party_kind = "customer"
    search_fields = ["code", "name", "contact_person", "phone", "email", "tax_id"]
    filterset_fields = ["is_active", "category"]
    ordering_fields = ["code", "name", "balance", "credit_limit", "created_at"]
    ordering = ["name"]
    export_columns = [("code", "Code", "text"), ("name", "Company", "text"), ("contact_person", "Contact", "text"),
                      ("phone", "Phone", "text"), ("email", "Email", "text"), ("tax_id", "PAN/VAT", "text"),
                      ("category.name", "Category", "text"), ("credit_limit", "Credit limit", "money"),
                      ("payment_terms_days", "Terms (days)", "number"), ("balance", "Balance", "money"),
                      ("is_active", "Active", "text")]

    def get_queryset(self):
        qs = super().get_queryset().annotate(balance=balance_subquery("customer", SystemAccount.RECEIVABLE))
        if self.request.query_params.get("has_balance") == "true":
            qs = qs.exclude(balance=0)
        return qs

    @action(detail=True, methods=["get"])
    def summary(self, request, pk=None):
        from django.utils import timezone

        from apps.sales.models import SalesInvoice, SalesOrder

        customer = self.get_object()
        today = timezone.localdate()
        invoices = SalesInvoice.objects.filter(customer=customer, status="POSTED")
        overdue = invoices.filter(due_date__lt=today, balance_due__gt=0)
        from apps.sales.services import credit_exposure

        return Response({
            "balance": party_balance(request.organization, customer=customer),
            "credit_limit": customer.credit_limit,
            "credit_exposure": credit_exposure(customer),
            "overdue_amount": sum((i.balance_due for i in overdue), 0),
            "overdue_count": overdue.count(),
            "open_orders": SalesOrder.objects.filter(customer=customer, status__in=["SUBMITTED", "APPROVED", "PARTIAL"]).count(),
            "last_invoice_date": invoices.aggregate(d=Max("invoice_date"))["d"],
            "unapplied_receipts": sum((r.unapplied_amount for r in customer.receipts.filter(status="POSTED")), 0),
        })

    @extend_schema(request=OpeningBalanceSerializer, responses=CustomerSerializer)
    @action(detail=True, methods=["post"], url_path="opening-balance")
    def opening_balance(self, request, pk=None):
        data = OpeningBalanceSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        customer = post_customer_opening_balance(self.get_object(), request.user, data.validated_data["amount"],
                                                 data.validated_data["date"], request=request)
        return Response(self.get_serializer(self.get_queryset().get(pk=customer.pk)).data)
