"""Common actions for trade documents: PDF, audit timeline and connected documents."""
from django.db import transaction
from django.db.models import F
from drf_spectacular.utils import extend_schema
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.audit.services import record_event

from .pdf import pdf_response, render_pdf
from .viewsets import OrganizationModelViewSet


class DocumentViewSet(OrganizationModelViewSet):
    pdf_template = None
    pdf_title = ""
    entity_type = None  # audit entity name used by services (model name in lower case)

    def fresh(self, obj):
        return Response(self.get_serializer(self.get_queryset().get(pk=obj.pk)).data)

    def pdf_context(self, obj):
        return {}

    @action(detail=True, methods=["get"])
    def pdf(self, request, pk=None):
        obj = self.get_object()
        model = type(obj)
        copy_label = "DRAFT" if getattr(obj, "status", "") in ("DRAFT", "SUBMITTED") else "ORIGINAL"
        if hasattr(obj, "print_count") and copy_label != "DRAFT":
            with transaction.atomic():
                printed = model.objects.select_for_update().get(pk=obj.pk)
                copy_label = "ORIGINAL" if printed.print_count == 0 else f"COPY {printed.print_count}"
                model.objects.filter(pk=obj.pk).update(print_count=F("print_count") + 1)
        if getattr(obj, "status", "") in ("CANCELLED", "REVERSED"):
            copy_label = obj.get_status_display().upper()
        context = {"organization": request.organization, "doc": obj, "title": self.pdf_title, "copy_label": copy_label,
                   **self.pdf_context(obj)}
        pdf = render_pdf(self.pdf_template, context, request)
        record_event(request, "printed", self.entity_type or model.__name__.lower(), obj, new={"copy": copy_label})
        name = (getattr(obj, "number", "") or f"draft-{obj.pk}").replace("/", "-")
        return pdf_response(pdf, f"{name}.pdf", inline=request.query_params.get("download") != "1")

    @action(detail=True, methods=["get"])
    def timeline(self, request, pk=None):
        from apps.audit.models import AuditEvent
        from apps.audit.serializers import AuditEventSerializer

        from .related import related_documents

        obj = self.get_object()
        entity = self.entity_type or type(obj).__name__.lower()
        events = AuditEvent.objects.filter(organization=request.organization, entity_type=entity, entity_id=str(obj.pk))
        return Response({
            "events": AuditEventSerializer(events.select_related("user")[:200], many=True).data,
            "related": related_documents(obj),
        })

    @action(detail=False, methods=["get"])
    def export(self, request):
        """CSV/Excel export of the filtered list (same filters as the list endpoint, up to 20,000 rows)."""
        from .export import export_response

        rows = self.filter_queryset(self.get_queryset())[:20000]
        self.action = "list"
        data = self.get_serializer_class()(rows, many=True, context=self.get_serializer_context()).data
        columns = []
        for key in (data[0].keys() if data else []):
            if key == "id" or key.endswith("_bs") or key in ("lines", "allocations", "customer", "supplier", "warehouse") or (
                    key.endswith("_id")):
                continue
            if key.endswith("date") or key.endswith("_at"):
                kind = "date" if key.endswith("date") else "text"
            elif any(word in key for word in ("total", "amount", "balance", "paid", "credited", "value")):
                kind = "money"
            else:
                kind = "text"
            columns.append((key, key.replace("_", " ").capitalize(), kind))
        return export_response(data, columns, self.basename or "export", request.query_params.get("export", "csv"))

    @extend_schema(exclude=True)
    def destroy(self, request, *args, **kwargs):
        return super().destroy(request, *args, **kwargs)
