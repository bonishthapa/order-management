"""Attachments on business documents. Files are served only through this authenticated API."""
import mimetypes
import os

from django.conf import settings
from django.http import FileResponse
from rest_framework import mixins, serializers, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.response import Response

from apps.audit.services import record_event

from .models import Attachment
from .permissions import HasModulePermission, require

ENTITIES = {
    # entity type: (model path, view permission, manage permission)
    "expense": ("expenses.Expense", "expenses.view", "expenses.manage"),
    "supplierbill": ("purchases.SupplierBill", "purchases.view", "purchases.bill"),
    "purchaseorder": ("purchases.PurchaseOrder", "purchases.view", "purchases.manage"),
    "goodsreceipt": ("purchases.GoodsReceipt", "purchases.view", "purchases.receive"),
    "paymentvoucher": ("payments.PaymentVoucher", "purchases.view", "purchases.payment"),
    "salesorder": ("sales.SalesOrder", "sales.view", "sales.manage"),
    "salesinvoice": ("sales.SalesInvoice", "sales.view", "sales.invoice"),
    "customerreceipt": ("payments.CustomerReceipt", "sales.view", "sales.receipt"),
    "journalentry": ("accounting.JournalEntry", "accounting.view", "accounting.manage"),
    "customer": ("customers.Customer", "customers.view", "customers.manage"),
    "supplier": ("suppliers.Supplier", "suppliers.view", "suppliers.manage"),
}
ALLOWED_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".webp", ".xlsx", ".csv", ".docx", ".txt"}
SIGNATURES = {".pdf": [b"%PDF"], ".png": [b"\x89PNG"], ".jpg": [b"\xff\xd8\xff"], ".jpeg": [b"\xff\xd8\xff"],
              ".webp": [b"RIFF"], ".xlsx": [b"PK\x03\x04"], ".docx": [b"PK\x03\x04"]}


class AttachmentSerializer(serializers.ModelSerializer):
    uploaded_by = serializers.CharField(source="created_by.full_name", read_only=True, default=None)

    class Meta:
        model = Attachment
        fields = ["id", "entity_type", "entity_id", "original_name", "content_type", "size", "uploaded_by", "created_at"]


def _entity(request, entity_type, entity_id, manage=False):
    from django.apps import apps

    if entity_type not in ENTITIES:
        raise ValidationError({"entity_type": ["Attachments are not supported for this record type."]})
    model_path, view_perm, manage_perm = ENTITIES[entity_type]
    require(request, manage_perm if manage else view_perm)
    model = apps.get_model(model_path)
    obj = model.objects.filter(organization=request.organization, pk=entity_id).first()
    if obj is None:
        raise ValidationError({"entity_id": ["Record not found."]})
    return obj


class AttachmentViewSet(mixins.ListModelMixin, mixins.CreateModelMixin, mixins.DestroyModelMixin, viewsets.GenericViewSet):
    serializer_class = AttachmentSerializer
    permission_classes = [HasModulePermission]
    parser_classes = [MultiPartParser, FormParser]
    pagination_class = None

    def get_queryset(self):
        return Attachment.objects.filter(organization=self.request.organization).select_related("created_by")

    def list(self, request, *args, **kwargs):
        entity_type, entity_id = request.query_params.get("entity_type"), request.query_params.get("entity_id")
        _entity(request, entity_type, entity_id)
        qs = self.get_queryset().filter(entity_type=entity_type, entity_id=entity_id)
        return Response(self.get_serializer(qs, many=True).data)

    def create(self, request, *args, **kwargs):
        entity_type, entity_id = request.data.get("entity_type"), request.data.get("entity_id")
        obj = _entity(request, entity_type, entity_id, manage=True)
        upload = request.FILES.get("file")
        if upload is None:
            raise ValidationError({"file": ["Choose a file."]})
        ext = os.path.splitext(upload.name)[1].lower()
        if ext not in ALLOWED_EXTENSIONS:
            raise ValidationError({"file": [f"Allowed types: {', '.join(sorted(ALLOWED_EXTENSIONS))}."]})
        if upload.size > settings.MAX_ATTACHMENT_SIZE:
            raise ValidationError({"file": [f"Files must be smaller than {settings.MAX_ATTACHMENT_SIZE // (1024 * 1024)} MB."]})
        head = upload.read(8)
        upload.seek(0)
        if ext in SIGNATURES and not any(head.startswith(sig) for sig in SIGNATURES[ext]):
            raise ValidationError({"file": ["The file content does not match its extension."]})
        attachment = Attachment.objects.create(
            organization=request.organization, created_by=request.user, entity_type=entity_type, entity_id=obj.pk,
            file=upload, original_name=os.path.basename(upload.name)[:255],
            content_type=mimetypes.guess_type(upload.name)[0] or "application/octet-stream", size=upload.size,
        )
        record_event(request, "attachment.added", entity_type, obj, new={"file": attachment.original_name})
        return Response(self.get_serializer(attachment).data, status=201)

    def perform_destroy(self, instance):
        obj = _entity(self.request, instance.entity_type, instance.entity_id, manage=True)
        if getattr(obj, "status", "DRAFT") not in ("DRAFT", "SUBMITTED", "REJECTED"):
            raise ValidationError("Attachments of posted documents cannot be removed.")
        record_event(self.request, "attachment.removed", instance.entity_type, obj, old={"file": instance.original_name})
        instance.file.delete(save=False)
        instance.delete()

    @action(detail=True, methods=["get"])
    def download(self, request, pk=None):
        attachment = self.get_queryset().get(pk=pk)
        _entity(request, attachment.entity_type, attachment.entity_id)
        response = FileResponse(attachment.file.open("rb"), content_type=attachment.content_type,
                                as_attachment=request.query_params.get("inline") != "1", filename=attachment.original_name)
        response["X-Content-Type-Options"] = "nosniff"
        return response
