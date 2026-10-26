from django.conf import settings
from django.db import models


class TimeStampedModel(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class OrganizationOwned(TimeStampedModel):
    organization = models.ForeignKey("organizations.Organization", on_delete=models.PROTECT, related_name="+")
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )

    class Meta:
        abstract = True


class DocumentStatus(models.TextChoices):
    DRAFT = "DRAFT", "Draft"
    SUBMITTED = "SUBMITTED", "Submitted"
    APPROVED = "APPROVED", "Approved"
    REJECTED = "REJECTED", "Rejected"
    POSTED = "POSTED", "Posted"
    PARTIAL = "PARTIAL", "Partially fulfilled"
    COMPLETED = "COMPLETED", "Completed"
    CANCELLED = "CANCELLED", "Cancelled"
    REVERSED = "REVERSED", "Reversed"


class DocumentSequence(models.Model):
    """Database-backed counter. One row per (organisation, document type, numbering scope).

    Rows are locked with SELECT ... FOR UPDATE while a number is issued, so concurrent
    postings serialise on the counter and never produce duplicates or reuse a number.
    """

    organization = models.ForeignKey("organizations.Organization", on_delete=models.CASCADE)
    doc_type = models.CharField(max_length=20)
    scope = models.CharField(max_length=40, blank=True, default="")
    last_value = models.PositiveBigIntegerField(default=0)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["organization", "doc_type", "scope"], name="uniq_document_sequence")
        ]


class Attachment(OrganizationOwned):
    """File attached to a business document. Linked generically by entity type + id."""

    entity_type = models.CharField(max_length=60)
    entity_id = models.PositiveBigIntegerField()
    file = models.FileField(upload_to="attachments/%Y/%m/")
    original_name = models.CharField(max_length=255)
    content_type = models.CharField(max_length=100)
    size = models.PositiveIntegerField()

    class Meta:
        indexes = [models.Index(fields=["organization", "entity_type", "entity_id"])]
