from rest_framework import serializers

from apps.accounting.models import Account
from apps.core.serializers import BaseModelSerializer, OrgRelatedField

from .models import Branch, NumberingPolicy, Organization, PaymentMethod, TaxRate, UnitOfMeasure


class OrganizationSerializer(BaseModelSerializer):
    class Meta:
        model = Organization
        fields = [
            "id", "name", "legal_name", "code", "logo", "address", "city", "country", "email", "phone", "website", "tax_id",
            "currency", "currency_symbol", "locale", "timezone", "date_display_mode", "date_input_calendar",
            "negative_stock_policy", "allow_invoice_before_delivery", "require_sales_order_approval",
            "require_purchase_order_approval", "require_expense_approval", "terms_and_conditions", "document_footer",
            "updated_at",
        ]
        read_only_fields = ["id", "code", "updated_at"]

    def validate_logo(self, value):
        if value and value.size > 1024 * 1024:
            raise serializers.ValidationError("The logo must be smaller than 1 MB.")
        return value

    def validate_timezone(self, value):
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise serializers.ValidationError("Unknown timezone.")
        return value


class BranchSerializer(BaseModelSerializer):
    class Meta:
        model = Branch
        fields = ["id", "code", "name", "address", "phone", "is_active"]


class TaxRateSerializer(BaseModelSerializer):
    class Meta:
        model = TaxRate
        fields = ["id", "name", "rate", "is_default", "is_active"]


class UnitSerializer(BaseModelSerializer):
    class Meta:
        model = UnitOfMeasure
        fields = ["id", "code", "name", "allow_fractions", "is_active"]


class PaymentMethodSerializer(BaseModelSerializer):
    default_account = OrgRelatedField(Account, required=False, allow_null=True)
    default_account_name = serializers.CharField(source="default_account.__str__", read_only=True, default=None)

    class Meta:
        model = PaymentMethod
        fields = ["id", "name", "kind", "default_account", "default_account_name", "requires_reference", "is_active"]

    def validate_default_account(self, value):
        if value and not (value.is_cash or value.is_bank):
            raise serializers.ValidationError("Choose a cash or bank account.")
        return value


class NumberingPolicySerializer(BaseModelSerializer):
    doc_type_label = serializers.CharField(source="get_doc_type_display", read_only=True)
    example = serializers.SerializerMethodField()

    class Meta:
        model = NumberingPolicy
        fields = ["id", "doc_type", "doc_type_label", "prefix", "separator", "reset_policy", "padding", "include_branch", "example"]
        read_only_fields = ["doc_type"]

    def get_example(self, policy):
        from django.utils import timezone

        from apps.core.exceptions import BusinessRuleError
        from apps.core.numbering import preview_number

        try:
            return preview_number(policy.organization, policy.doc_type, timezone.localdate(), "BR1" if policy.include_branch else "")
        except BusinessRuleError as exc:
            return f"({exc.detail})"

    def validate_prefix(self, value):
        if not value.replace("-", "").replace("/", "").isalnum():
            raise serializers.ValidationError("Use letters, digits, '-' or '/'.")
        return value.upper()
