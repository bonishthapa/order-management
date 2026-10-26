from django.db import transaction
from rest_framework import serializers

from apps.calendar_utils.fields import DualDateSerializerMixin
from apps.core.exceptions import BusinessRuleError


class OrgRelatedField(serializers.PrimaryKeyRelatedField):
    """Primary-key relation restricted to the request's organisation.

    An id from another organisation is reported as "does not exist", so modified ids in a
    request body can never attach or reveal another organisation's records.
    """

    def __init__(self, model=None, org_path="organization", extra_filter=None, **kwargs):
        self.model = model
        self.org_path = org_path
        self.extra_filter = extra_filter or {}
        if not kwargs.get("read_only"):
            kwargs.setdefault("queryset", model.objects.none() if model else None)
        super().__init__(**kwargs)

    def get_queryset(self):
        organization = self.context.get("organization")
        if organization is None:
            return self.model.objects.none()
        return self.model.objects.filter(**{self.org_path: organization}, **self.extra_filter)


class BaseModelSerializer(DualDateSerializerMixin, serializers.ModelSerializer):
    """Adds ``<date>_bs`` fields and keeps organisation/creator fields read-only."""

    @property
    def organization(self):
        return self.context.get("organization")


class DocumentSerializer(BaseModelSerializer):
    """Header + nested ``lines`` written together. Totals are always recomputed on the server.

    Subclasses define ``line_serializer_class``, ``line_fk`` (FK name on the line model) and
    ``editable_statuses``. Lines are replaced wholesale on update, only while editable.
    """

    line_serializer_class = None
    line_fk = None
    editable_statuses = ("DRAFT",)
    number_doc_type = None  # assign a number on create (orders); others number on posting
    number_date_field = None

    def validate(self, attrs):
        attrs = super().validate(attrs)
        lines = attrs.get("lines")
        if self.instance is None and not lines:
            raise serializers.ValidationError({"lines": ["Add at least one line."]})
        return attrs

    def _save_lines(self, instance, lines_data):
        line_model = self.line_serializer_class.Meta.model
        line_model.objects.filter(**{self.line_fk: instance}).delete()
        lines = [line_model(**{self.line_fk: instance}, **data) for data in lines_data]
        if hasattr(instance, "recalculate"):
            instance.recalculate(lines)
        line_model.objects.bulk_create(lines)
        if hasattr(instance, "recalculate"):
            instance.save()
        return lines

    @transaction.atomic
    def create(self, validated_data):
        lines_data = validated_data.pop("lines", [])
        instance = self.Meta.model(**validated_data)
        if self.number_doc_type:
            from apps.core.numbering import next_number

            instance.number = next_number(instance.organization, self.number_doc_type,
                                          getattr(instance, self.number_date_field))
        instance.save()
        self._save_lines(instance, lines_data)
        return instance

    @transaction.atomic
    def update(self, instance, validated_data):
        instance = type(instance).objects.select_for_update().get(pk=instance.pk)
        if instance.status not in self.editable_statuses:
            raise BusinessRuleError(f"A {instance.get_status_display().lower()} document cannot be edited.", "not_editable")
        lines_data = validated_data.pop("lines", None)
        for key, value in validated_data.items():
            setattr(instance, key, value)
        if instance.status == "REJECTED":
            instance.status = "DRAFT"
        instance.save()
        if lines_data is not None:
            self._save_lines(instance, lines_data)
        elif hasattr(instance, "recalculate"):
            instance.recalculate()
            for line in instance.lines.all():
                line.save()
            instance.save()
        return instance


class ReasonSerializer(serializers.Serializer):
    reason = serializers.CharField(max_length=1000)


class OptionalReasonSerializer(serializers.Serializer):
    reason = serializers.CharField(max_length=1000, required=False, allow_blank=True, default="")


class AllocationItemSerializer(serializers.Serializer):
    document = serializers.IntegerField()
    amount = serializers.DecimalField(max_digits=18, decimal_places=2, min_value=0)
