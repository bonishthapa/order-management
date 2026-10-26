from rest_framework import mixins, viewsets
from rest_framework.decorators import action

from apps.core.export import export_response
from apps.core.permissions import HasModulePermission
from apps.calendar_utils.ranges import resolve_date_range

from .models import AuditEvent
from .serializers import AuditEventSerializer


class AuditEventViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    """Read-only audit trail. There are no write endpoints."""

    serializer_class = AuditEventSerializer
    permission_classes = [HasModulePermission]
    permission_map = {"list": "audit.view", "retrieve": "audit.view", "export": "audit.view"}
    search_fields = ["entity_label", "action", "entity_type", "reason", "user__full_name", "user__email", "request_id"]
    filterset_fields = {"entity_type": ["exact"], "entity_id": ["exact"], "user": ["exact"], "action": ["exact", "startswith"]}
    ordering = ["-created_at", "-id"]

    def get_queryset(self):
        qs = AuditEvent.objects.filter(organization=self.request.organization).select_related("user")
        date_range = resolve_date_range(self.request.query_params, self.request.organization)
        return qs.filter(**date_range.datetime_filter_kwargs("created_at", self.request.organization.timezone))

    @action(detail=False, methods=["get"])
    def export(self, request):
        columns = [("created_at", "Timestamp", "text"), ("user.full_name", "User", "text"), ("action", "Action", "text"),
                   ("entity_type", "Entity", "text"), ("entity_id", "Record ID", "text"), ("entity_label", "Record", "text"),
                   ("reason", "Reason", "text"), ("request_id", "Request ID", "text")]
        return export_response(self.filter_queryset(self.get_queryset())[:20000], columns, "audit-trail",
                               request.query_params.get("export", "csv"))
