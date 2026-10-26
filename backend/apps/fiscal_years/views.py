from django.db.models import Count
from drf_spectacular.utils import extend_schema
from rest_framework import mixins, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.core.permissions import HasModulePermission
from apps.core.serializers import OptionalReasonSerializer, ReasonSerializer
from apps.core.viewsets import OrganizationScopedMixin

from . import closing, services
from .models import AccountingPeriod, FiscalYear
from .serializers import (
    AccountingPeriodSerializer,
    ClosingSerializer,
    CloseRequestSerializer,
    FiscalYearListSerializer,
    FiscalYearSerializer,
)


class FiscalYearViewSet(OrganizationScopedMixin, mixins.ListModelMixin, mixins.RetrieveModelMixin, mixins.CreateModelMixin,
                        mixins.UpdateModelMixin, viewsets.GenericViewSet):
    queryset = FiscalYear.objects.select_related("created_by", "approved_by", "closed_by").prefetch_related("periods__locked_by")
    serializer_class = FiscalYearSerializer
    permission_module = "fiscal"
    permission_map = {"list": None, "retrieve": None, "current": None, "activate": "fiscal.manage",
                      "closing_preview": ("fiscal.close", "fiscal.view"), "close": "fiscal.close", "reopen": "fiscal.reopen",
                      "closings": "fiscal.view"}
    filterset_fields = ["status"]
    ordering = ["-start_date"]
    pagination_class = None

    def get_serializer_class(self):
        return FiscalYearListSerializer if self.action == "list" else FiscalYearSerializer

    def perform_create(self, serializer):
        data = serializer.validated_data
        serializer.instance = services.create_fiscal_year(
            self.request.organization, self.request.user, name=data["name"], code=data["code"],
            start_date=data["start_date"], end_date=data["end_date"], period_type=data.get("period_type", "BS_MONTHLY"),
            notes=data.get("notes", ""), request=self.request,
        )

    def perform_update(self, serializer):
        serializer.instance = services.update_draft_fiscal_year(serializer.instance, self.request.user,
                                                                serializer.validated_data, request=self.request)

    def _detail(self, fiscal_year):
        fiscal_year = self.get_queryset().get(pk=fiscal_year.pk)
        return Response(FiscalYearSerializer(fiscal_year, context=self.get_serializer_context()).data)

    @action(detail=False, methods=["get"])
    def current(self, request):
        fiscal_year = FiscalYear.current(request.organization)
        if fiscal_year is None:
            return Response(None)
        return self._detail(fiscal_year)

    @extend_schema(request=None)
    @action(detail=True, methods=["post"])
    def activate(self, request, pk=None):
        return self._detail(services.activate_fiscal_year(self.get_object(), request.user, request=request))

    @action(detail=True, methods=["get"], url_path="closing-preview")
    def closing_preview(self, request, pk=None):
        return Response(closing.preview(self.get_object()))

    @extend_schema(request=CloseRequestSerializer)
    @action(detail=True, methods=["post"])
    def close(self, request, pk=None):
        data = CloseRequestSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        closing.close(self.get_object(), request.user, data.validated_data["confirmation"], request=request)
        return self._detail(self.get_object())

    @extend_schema(request=ReasonSerializer)
    @action(detail=True, methods=["post"])
    def reopen(self, request, pk=None):
        data = ReasonSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        return self._detail(closing.reopen(self.get_object(), request.user, data.validated_data["reason"], request=request))

    @action(detail=True, methods=["get"])
    def closings(self, request, pk=None):
        return Response(ClosingSerializer(self.get_object().closings.order_by("-id"), many=True).data)


class AccountingPeriodViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    queryset = AccountingPeriod.objects.select_related("fiscal_year", "locked_by")
    serializer_class = AccountingPeriodSerializer
    permission_map = {"list": None, "retrieve": None, "lock": "fiscal.manage", "unlock": "fiscal.reopen"}
    filterset_fields = ["fiscal_year", "status"]
    ordering = ["fiscal_year__start_date", "number"]
    pagination_class = None
    permission_classes = [HasModulePermission]

    def get_queryset(self):
        return super().get_queryset().filter(fiscal_year__organization=self.request.organization).annotate(
            journal_count=Count("journals"))

    @extend_schema(request=OptionalReasonSerializer)
    @action(detail=True, methods=["post"])
    def lock(self, request, pk=None):
        data = OptionalReasonSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        period = services.lock_period(self.get_object(), request.user, data.validated_data["reason"], request=request)
        return Response(self.get_serializer(self.get_queryset().get(pk=period.pk)).data)

    @extend_schema(request=ReasonSerializer)
    @action(detail=True, methods=["post"])
    def unlock(self, request, pk=None):
        data = ReasonSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        period = services.unlock_period(self.get_object(), request.user, data.validated_data["reason"], request=request)
        return Response(self.get_serializer(self.get_queryset().get(pk=period.pk)).data)
