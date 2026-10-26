from django.db import transaction
from rest_framework import serializers

from apps.core.numbering import next_code
from apps.core.serializers import BaseModelSerializer, OrgRelatedField

from .models import Supplier, SupplierCategory

BANK_FIELDS = ("bank_name", "bank_account_name", "bank_account_number", "bank_branch")


class SupplierCategorySerializer(BaseModelSerializer):
    class Meta:
        model = SupplierCategory
        fields = ["id", "name", "is_active"]


class SupplierSerializer(BaseModelSerializer):
    category = OrgRelatedField(SupplierCategory, required=False, allow_null=True)
    category_name = serializers.CharField(source="category.name", read_only=True, default=None)
    balance = serializers.DecimalField(max_digits=18, decimal_places=2, read_only=True, default=None)
    opening_balance_posted = serializers.SerializerMethodField()
    bank_details_visible = serializers.SerializerMethodField()

    class Meta:
        model = Supplier
        fields = [
            "id", "code", "name", "contact_person", "phone", "email", "address", "tax_id", "payment_terms_days",
            "category", "category_name", *BANK_FIELDS, "bank_details_visible", "notes", "is_active",
            "opening_balance", "opening_balance_date", "opening_balance_posted", "balance", "created_at", "updated_at",
        ]
        read_only_fields = ["id", "opening_balance", "opening_balance_date", "created_at", "updated_at"]
        extra_kwargs = {"code": {"required": False, "allow_blank": True}}

    def _can_see_bank(self):
        request = self.context.get("request")
        return request is not None and "suppliers.bank_view" in getattr(request, "perms", set())

    def get_bank_details_visible(self, obj):
        return self._can_see_bank()

    def get_opening_balance_posted(self, obj):
        return obj.opening_balance_journal_id is not None

    def to_representation(self, instance):
        data = super().to_representation(instance)
        if not self._can_see_bank():
            for field in BANK_FIELDS:
                data[field] = None
        elif data.get("bank_account_number") and self.context.get("view") and getattr(self.context["view"], "action", "") == "list":
            data["bank_account_number"] = "•••• " + data["bank_account_number"][-4:]
        return data

    def validate(self, attrs):
        attrs = super().validate(attrs)
        if not self._can_see_bank():
            for field in BANK_FIELDS:
                attrs.pop(field, None)
        return attrs

    def validate_code(self, value):
        value = (value or "").strip().upper()
        if value:
            qs = Supplier.objects.filter(organization=self.organization, code=value)
            if self.instance:
                qs = qs.exclude(pk=self.instance.pk)
            if qs.exists():
                raise serializers.ValidationError("Another supplier already uses this code.")
        return value

    @transaction.atomic
    def create(self, validated_data):
        if not validated_data.get("code"):
            validated_data["code"] = next_code(validated_data["organization"], "supplier", "SUP")
        return super().create(validated_data)
