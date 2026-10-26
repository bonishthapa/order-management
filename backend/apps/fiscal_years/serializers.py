from rest_framework import serializers

from apps.core.serializers import BaseModelSerializer

from .models import AccountingPeriod, FiscalYear, FiscalYearClosing


class AccountingPeriodSerializer(BaseModelSerializer):
    locked_by_name = serializers.CharField(source="locked_by.full_name", read_only=True, default=None)
    fiscal_year_name = serializers.CharField(source="fiscal_year.name", read_only=True)
    journal_count = serializers.IntegerField(read_only=True, default=None)

    class Meta:
        model = AccountingPeriod
        fields = ["id", "fiscal_year", "fiscal_year_name", "number", "name", "start_date", "end_date", "status",
                  "locked_by", "locked_by_name", "locked_at", "lock_reason", "journal_count"]
        read_only_fields = fields


class FiscalYearSerializer(BaseModelSerializer):
    periods = AccountingPeriodSerializer(many=True, read_only=True)
    created_by_name = serializers.CharField(source="created_by.full_name", read_only=True, default=None)
    approved_by_name = serializers.CharField(source="approved_by.full_name", read_only=True, default=None)
    closed_by_name = serializers.CharField(source="closed_by.full_name", read_only=True, default=None)
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    label = serializers.SerializerMethodField()

    class Meta:
        model = FiscalYear
        fields = [
            "id", "name", "code", "label", "start_date", "end_date", "period_type", "status", "status_label",
            "opening_balance_status", "closing_status", "created_by", "created_by_name", "approved_by",
            "approved_by_name", "approved_at", "closed_by", "closed_by_name", "closed_at", "created_at", "notes", "periods",
        ]
        read_only_fields = ["id", "status", "opening_balance_status", "closing_status", "created_by", "approved_by",
                            "approved_at", "closed_by", "closed_at", "created_at"]

    def get_label(self, fy):
        return f"Fiscal Year {fy.name} · AD {fy.start_date} – {fy.end_date} · BS {fy.start_date_bs} – {fy.end_date_bs}"

    def validate(self, attrs):
        attrs = super().validate(attrs)
        start = attrs.get("start_date", getattr(self.instance, "start_date", None))
        end = attrs.get("end_date", getattr(self.instance, "end_date", None))
        if start and end and end <= start:
            raise serializers.ValidationError({"end_date": ["The end date must be after the start date."]})
        return attrs


class FiscalYearListSerializer(FiscalYearSerializer):
    class Meta(FiscalYearSerializer.Meta):
        fields = [f for f in FiscalYearSerializer.Meta.fields if f != "periods"]


class ClosingSerializer(BaseModelSerializer):
    closed_by_name = serializers.CharField(source="closed_by.full_name", read_only=True)
    closing_journal_number = serializers.CharField(source="closing_journal.number", read_only=True, default=None)

    class Meta:
        model = FiscalYearClosing
        fields = ["id", "summary", "closing_journal", "closing_journal_number", "closed_by_name", "created_at", "reopened_at"]


class CloseRequestSerializer(serializers.Serializer):
    confirmation = serializers.CharField(help_text="Type the fiscal year code to confirm")
