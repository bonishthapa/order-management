from rest_framework import serializers

from apps.accounting.models import Account, AccountType
from apps.core.serializers import BaseModelSerializer, OrgRelatedField
from apps.organizations.models import PaymentMethod, TaxRate
from apps.suppliers.models import Supplier

from .models import Expense, ExpenseCategory
from .services import calculate


class ExpenseCategorySerializer(BaseModelSerializer):
    account = OrgRelatedField(Account, extra_filter={"account_type": AccountType.EXPENSE, "is_group": False})
    account_name = serializers.CharField(source="account.__str__", read_only=True)

    class Meta:
        model = ExpenseCategory
        fields = ["id", "name", "account", "account_name", "is_active"]


class ExpenseSerializer(BaseModelSerializer):
    category = OrgRelatedField(ExpenseCategory, extra_filter={"is_active": True})
    supplier = OrgRelatedField(Supplier, required=False, allow_null=True)
    tax_rate = OrgRelatedField(TaxRate, required=False, allow_null=True)
    payment_method = OrgRelatedField(PaymentMethod, extra_filter={"is_active": True})
    paid_from_account = OrgRelatedField(Account, extra_filter={"is_group": False, "is_active": True})
    category_name = serializers.CharField(source="category.name", read_only=True)
    payment_method_name = serializers.CharField(source="payment_method.name", read_only=True)
    paid_from_account_name = serializers.CharField(source="paid_from_account.__str__", read_only=True)
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    created_by_name = serializers.CharField(source="created_by.full_name", read_only=True, default=None)
    approved_by_name = serializers.CharField(source="approved_by.full_name", read_only=True, default=None)
    journal_number = serializers.CharField(source="journal.number", read_only=True, default=None)
    attachment_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = Expense
        fields = ["id", "number", "fiscal_year", "category", "category_name", "date", "payee", "supplier", "amount",
                  "tax_rate", "tax_percent", "tax_amount", "total", "payment_method", "payment_method_name",
                  "paid_from_account", "paid_from_account_name", "reference", "description", "status", "status_label",
                  "submitted_at", "approved_by_name", "approved_at", "rejection_reason", "reversal_reason", "journal",
                  "journal_number", "created_by_name", "attachment_count", "created_at"]
        read_only_fields = ["number", "fiscal_year", "tax_percent", "tax_amount", "total", "status", "submitted_at",
                            "approved_at", "rejection_reason", "reversal_reason", "journal"]

    def validate(self, attrs):
        attrs = super().validate(attrs)
        account = attrs.get("paid_from_account")
        if account and not (account.is_cash or account.is_bank):
            raise serializers.ValidationError({"paid_from_account": ["Choose a cash or bank account."]})
        if self.instance and self.instance.status not in ("DRAFT", "REJECTED"):
            raise serializers.ValidationError("Only draft or rejected expenses can be edited.")
        return attrs

    def create(self, validated_data):
        expense = Expense(**validated_data)
        calculate(expense)
        expense.save()
        return expense

    def update(self, instance, validated_data):
        for key, value in validated_data.items():
            setattr(instance, key, value)
        if instance.status == "REJECTED":
            instance.status = "DRAFT"
        calculate(instance)
        instance.save()
        return instance
