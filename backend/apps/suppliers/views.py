from django.db.models import Max
from drf_spectacular.utils import extend_schema
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.accounting.models import SystemAccount
from apps.accounting.opening import post_supplier_opening_balance
from apps.accounting.services import party_balance
from apps.audit.services import record_event, snapshot
from apps.core.party_views import PartyActionsMixin, balance_subquery
from apps.core.viewsets import OrganizationModelViewSet
from apps.customers.serializers import OpeningBalanceSerializer

from .models import Supplier, SupplierCategory
from .serializers import BANK_FIELDS, SupplierCategorySerializer, SupplierSerializer


class SupplierCategoryViewSet(OrganizationModelViewSet):
    queryset = SupplierCategory.objects.all()
    serializer_class = SupplierCategorySerializer
    permission_module = "suppliers"
    permission_map = {"list": None, "retrieve": None}
    pagination_class = None

    def perform_create(self, serializer):
        serializer.save(organization=self.request.organization)


class SupplierViewSet(PartyActionsMixin, OrganizationModelViewSet):
    queryset = Supplier.objects.select_related("category")
    serializer_class = SupplierSerializer
    permission_module = "suppliers"
    permission_map = {"opening_balance": "suppliers.manage", "export": "suppliers.view"}
    audit_entity = "supplier"
    party_kind = "supplier"
    search_fields = ["code", "name", "contact_person", "phone", "email", "tax_id"]
    filterset_fields = ["is_active", "category"]
    ordering_fields = ["code", "name", "balance", "created_at"]
    ordering = ["name"]
    export_columns = [("code", "Code", "text"), ("name", "Company", "text"), ("contact_person", "Contact", "text"),
                      ("phone", "Phone", "text"), ("email", "Email", "text"), ("tax_id", "PAN/VAT", "text"),
                      ("category.name", "Category", "text"), ("payment_terms_days", "Terms (days)", "number"),
                      ("balance", "Balance", "money"), ("is_active", "Active", "text")]

    def get_queryset(self):
        qs = super().get_queryset().annotate(balance=balance_subquery("supplier", SystemAccount.PAYABLE, credit_normal=True))
        if self.request.query_params.get("has_balance") == "true":
            qs = qs.exclude(balance=0)
        return qs

    def retrieve(self, request, *args, **kwargs):
        response = super().retrieve(request, *args, **kwargs)
        if "suppliers.bank_view" in request.perms and any(response.data.get(f) for f in BANK_FIELDS):
            record_event(request, "supplier.bank_details_viewed", "supplier", entity_id=kwargs.get("pk"))
        return response

    def perform_update(self, serializer):
        before = snapshot(serializer.instance)
        instance = serializer.save()
        record_event(self.request, "updated", "supplier", instance, old=before, new=snapshot(instance))

    @action(detail=True, methods=["get"])
    def summary(self, request, pk=None):
        from django.utils import timezone

        from apps.purchases.models import PurchaseOrder, SupplierBill

        supplier = self.get_object()
        today = timezone.localdate()
        bills = SupplierBill.objects.filter(supplier=supplier, status="POSTED")
        overdue = bills.filter(due_date__lt=today, balance_due__gt=0)
        return Response({
            "balance": party_balance(request.organization, supplier=supplier),
            "overdue_amount": sum((b.balance_due for b in overdue), 0),
            "overdue_count": overdue.count(),
            "open_orders": PurchaseOrder.objects.filter(supplier=supplier, status__in=["SUBMITTED", "APPROVED", "PARTIAL"]).count(),
            "last_bill_date": bills.aggregate(d=Max("bill_date"))["d"],
            "unapplied_payments": sum((v.unapplied_amount for v in supplier.payments.filter(status="POSTED")), 0),
        })

    @extend_schema(request=OpeningBalanceSerializer, responses=SupplierSerializer)
    @action(detail=True, methods=["post"], url_path="opening-balance")
    def opening_balance(self, request, pk=None):
        data = OpeningBalanceSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        supplier = post_supplier_opening_balance(self.get_object(), request.user, data.validated_data["amount"],
                                                 data.validated_data["date"], request=request)
        return Response(self.get_serializer(self.get_queryset().get(pk=supplier.pk)).data)
