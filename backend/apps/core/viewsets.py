from django.db import transaction
from rest_framework import mixins, viewsets
from rest_framework.exceptions import ValidationError

from apps.audit.services import record_event, snapshot

from .permissions import HasModulePermission, allowed_warehouse_ids


class OrganizationScopedMixin:
    """Restricts every queryset to ``request.organization`` and stamps new rows with it."""

    permission_classes = [HasModulePermission]
    permission_module = None
    permission_map = {}
    warehouse_field = None  # e.g. "warehouse" to apply membership warehouse restrictions
    audit_entity = None  # e.g. "customer"; enables create/update audit events

    def get_queryset(self):
        qs = super().get_queryset().filter(organization=self.request.organization)
        if self.warehouse_field:
            ids = allowed_warehouse_ids(self.request)
            if ids is not None:
                qs = qs.filter(**{f"{self.warehouse_field}__in": ids})
        return qs

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["organization"] = getattr(self.request, "organization", None)
        return context

    def perform_create(self, serializer):
        with transaction.atomic():
            instance = serializer.save(organization=self.request.organization, created_by=self.request.user)
            if self.audit_entity:
                record_event(self.request, "created", self.audit_entity, instance, new=snapshot(instance))

    def perform_update(self, serializer):
        with transaction.atomic():
            before = snapshot(serializer.instance) if self.audit_entity else None
            instance = serializer.save()
            if self.audit_entity:
                record_event(self.request, "updated", self.audit_entity, instance, old=before, new=snapshot(instance))

    def perform_destroy(self, instance):
        if getattr(instance, "status", "DRAFT") not in ("DRAFT",):
            raise ValidationError("Only draft records can be deleted; use cancel or reverse instead.")
        with transaction.atomic():
            if self.audit_entity:
                record_event(self.request, "deleted", self.audit_entity, instance, old=snapshot(instance))
            instance.delete()


class OrganizationModelViewSet(OrganizationScopedMixin, viewsets.ModelViewSet):
    pass


class OrganizationReadOnlyViewSet(OrganizationScopedMixin, viewsets.ReadOnlyModelViewSet):
    pass


class NoDeleteOrganizationViewSet(
    OrganizationScopedMixin,
    mixins.CreateModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    mixins.ListModelMixin,
    viewsets.GenericViewSet,
):
    pass
