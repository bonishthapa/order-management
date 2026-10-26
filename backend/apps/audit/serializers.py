from rest_framework import serializers

from apps.calendar_utils.fields import bs_or_none

from .models import AuditEvent


class AuditEventSerializer(serializers.ModelSerializer):
    user_name = serializers.CharField(source="user.full_name", default=None)
    user_email = serializers.CharField(source="user.email", default=None)
    date_bs = serializers.SerializerMethodField()

    class Meta:
        model = AuditEvent
        fields = ["id", "created_at", "date_bs", "user", "user_name", "user_email", "action", "entity_type", "entity_id",
                  "entity_label", "old_values", "new_values", "reason", "request_id", "ip_address"]

    def get_date_bs(self, obj):
        from django.utils import timezone

        return bs_or_none(timezone.localtime(obj.created_at).date())
