from django.db import transaction
from rest_framework import serializers

from apps.core.numbering import next_code
from apps.core.serializers import BaseModelSerializer, OrgRelatedField

from .models import Customer, CustomerCategory


class CustomerCategorySerializer(BaseModelSerializer):
    class Meta:
        model = CustomerCategory
        fields = ["id", "name", "is_active"]


class CustomerSerializer(BaseModelSerializer):
    category = OrgRelatedField(CustomerCategory, required=False, allow_null=True)
    category_name = serializers.CharField(source="category.name", read_only=True, default=None)
    balance = serializers.DecimalField(max_digits=18, decimal_places=2, read_only=True, default=None)
    opening_balance_posted = serializers.SerializerMethodField()

    class Meta:
        model = Customer
        fields = [
            "id", "code", "name", "contact_person", "phone", "email", "billing_address", "shipping_address", "tax_id",
            "credit_limit", "payment_terms_days", "category", "category_name", "notes", "is_active",
            "opening_balance", "opening_balance_date", "opening_balance_posted", "balance", "created_at", "updated_at",
        ]
        read_only_fields = ["id", "opening_balance", "opening_balance_date", "created_at", "updated_at"]
        extra_kwargs = {"code": {"required": False, "allow_blank": True}}

    def get_opening_balance_posted(self, obj):
        return obj.opening_balance_journal_id is not None

    def validate_code(self, value):
        value = (value or "").strip().upper()
        if value:
            qs = Customer.objects.filter(organization=self.organization, code=value)
            if self.instance:
                qs = qs.exclude(pk=self.instance.pk)
            if qs.exists():
                raise serializers.ValidationError("Another customer already uses this code.")
        return value

    @transaction.atomic
    def create(self, validated_data):
        if not validated_data.get("code"):
            validated_data["code"] = next_code(validated_data["organization"], "customer", "CUS")
        return super().create(validated_data)


class OpeningBalanceSerializer(serializers.Serializer):
    amount = serializers.DecimalField(max_digits=18, decimal_places=2)
    date = serializers.DateField(required=False)
    date_bs = serializers.CharField(required=False)

    def validate(self, attrs):
        from apps.calendar_utils.fields import parse_date_input

        attrs["date"] = parse_date_input(attrs.get("date"), attrs.get("date_bs"), "date")
        if attrs["date"] is None:
            raise serializers.ValidationError({"date": ["Enter the opening balance date."]})
        return attrs
