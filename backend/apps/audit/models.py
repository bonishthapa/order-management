from django.conf import settings
from django.db import models


class AuditEvent(models.Model):
    """Append-only audit record. Rows cannot be updated or deleted through the ORM."""

    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    action = models.CharField(max_length=40)
    entity_type = models.CharField(max_length=60)
    entity_id = models.CharField(max_length=40)
    entity_label = models.CharField(max_length=200, blank=True)
    old_values = models.JSONField(null=True, blank=True)
    new_values = models.JSONField(null=True, blank=True)
    reason = models.TextField(blank=True)
    request_id = models.CharField(max_length=64, blank=True)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [
            models.Index(fields=["organization", "entity_type", "entity_id"]),
            models.Index(fields=["organization", "-created_at"]),
        ]

    def save(self, *args, **kwargs):
        if self.pk is not None:
            raise RuntimeError("Audit events are immutable")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise RuntimeError("Audit events are immutable")
