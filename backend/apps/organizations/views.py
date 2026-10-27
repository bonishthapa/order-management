from django.db import transaction
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework import mixins, viewsets
from rest_framework.decorators import api_view, parser_classes, permission_classes
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response

from apps.audit.services import record_event, snapshot
from apps.core.permissions import HasModulePermission, require
from apps.core.viewsets import OrganizationModelViewSet, OrganizationScopedMixin

from .models import Branch, NumberingPolicy, PaymentMethod, TaxRate, UnitOfMeasure
from .serializers import (
    BranchSerializer,
    NumberingPolicySerializer,
    OrganizationSerializer,
    PaymentMethodSerializer,
    TaxRateSerializer,
    UnitSerializer,
)


@extend_schema(request=OrganizationSerializer, responses=OrganizationSerializer, tags=["organizations"])
@api_view(["GET", "PATCH"])
@permission_classes([HasModulePermission])
@parser_classes([JSONParser, MultiPartParser, FormParser])
def current_organization(request):
    org = request.organization
    if request.method == "PATCH":
        require(request, "settings.manage")
        before = snapshot(org)
        serializer = OrganizationSerializer(org, data=request.data, partial=True, context={"organization": org})
        serializer.is_valid(raise_exception=True)
        with transaction.atomic():
            org = serializer.save()
            record_event(request, "organization.updated", "organization", org, old=before, new=snapshot(org))
    return Response(OrganizationSerializer(org, context={"request": request}).data)


class MasterListViewSet(OrganizationModelViewSet):
    """Settings lists every member can read; only settings managers can change."""

    permission_map = {"list": None, "retrieve": None}
    permission_module = "settings"

    def perform_create(self, serializer):
        with transaction.atomic():
            instance = serializer.save(organization=self.request.organization)
            record_event(self.request, "created", self.audit_entity, instance, new=snapshot(instance))


class BranchViewSet(MasterListViewSet):
    queryset = Branch.objects.all()
    serializer_class = BranchSerializer
    audit_entity = "branch"
    search_fields = ["code", "name"]


class TaxRateViewSet(MasterListViewSet):
    queryset = TaxRate.objects.all()
    serializer_class = TaxRateSerializer
    audit_entity = "tax_rate"

    def perform_update(self, serializer):
        with transaction.atomic():
            super().perform_update(serializer)
            if serializer.instance.is_default:
                TaxRate.objects.filter(organization=self.request.organization).exclude(pk=serializer.instance.pk).update(is_default=False)


class UnitViewSet(MasterListViewSet):
    queryset = UnitOfMeasure.objects.all()
    serializer_class = UnitSerializer
    audit_entity = "unit"
    search_fields = ["code", "name"]


class PaymentMethodViewSet(MasterListViewSet):
    queryset = PaymentMethod.objects.select_related("default_account")
    serializer_class = PaymentMethodSerializer
    audit_entity = "payment_method"


class NumberingPolicyViewSet(OrganizationScopedMixin, mixins.ListModelMixin, mixins.UpdateModelMixin, viewsets.GenericViewSet):
    queryset = NumberingPolicy.objects.all()
    serializer_class = NumberingPolicySerializer
    permission_module = "settings"
    audit_entity = "numbering_policy"
    pagination_class = None
