from rest_framework import serializers

from apps.core.serializers import BaseModelSerializer, OrgRelatedField
from apps.customers.models import Customer
from apps.suppliers.models import Supplier

from .models import Account, BankReconciliation, JournalEntry, JournalLine, JournalSource


class AccountSerializer(BaseModelSerializer):
    parent = OrgRelatedField(Account, extra_filter={"is_group": True}, required=False, allow_null=True)
    parent_name = serializers.CharField(source="parent.name", read_only=True, default=None)
    balance = serializers.DecimalField(max_digits=18, decimal_places=2, read_only=True, default=None)
    type_label = serializers.CharField(source="get_account_type_display", read_only=True)
    system_label = serializers.CharField(source="get_system_key_display", read_only=True)
    has_postings = serializers.SerializerMethodField()

    class Meta:
        model = Account
        fields = ["id", "code", "name", "account_type", "type_label", "parent", "parent_name", "system_key", "system_label",
                  "is_group", "is_cash", "is_bank", "bank_name", "bank_account_number", "bank_branch", "description",
                  "is_active", "balance", "has_postings"]
        read_only_fields = ["system_key"]

    def get_has_postings(self, obj):
        """Whether any journal line uses the account (annotated on lists; queried for single records)."""
        annotated = getattr(obj, "has_postings", None)
        return annotated if annotated is not None else obj.lines.exists()

    def validate(self, attrs):
        attrs = super().validate(attrs)
        instance = self.instance
        if instance and instance.system_key:
            for field in ("account_type", "is_group"):
                if field in attrs and attrs[field] != getattr(instance, field):
                    raise serializers.ValidationError({field: ["System accounts keep their type."]})
            if attrs.get("is_active") is False:
                raise serializers.ValidationError({"is_active": ["System accounts cannot be deactivated."]})
        if instance and instance.lines.exists():
            if "account_type" in attrs and attrs["account_type"] != instance.account_type:
                raise serializers.ValidationError({"account_type": ["Cannot change the type of an account with postings."]})
            if attrs.get("is_group"):
                raise serializers.ValidationError({"is_group": ["An account with postings cannot become a group."]})
        parent = attrs.get("parent")
        account_type = attrs.get("account_type", getattr(instance, "account_type", None))
        if parent and parent.account_type != account_type:
            raise serializers.ValidationError({"parent": ["The parent group must have the same account type."]})
        if (attrs.get("is_cash") or attrs.get("is_bank")) and account_type != "ASSET":
            raise serializers.ValidationError({"is_cash": ["Cash and bank accounts are assets."]})
        code = attrs.get("code")
        if code:
            qs = Account.objects.filter(organization=self.organization, code=code)
            if instance:
                qs = qs.exclude(pk=instance.pk)
            if qs.exists():
                raise serializers.ValidationError({"code": ["Another account uses this code."]})
        return attrs


class JournalLineSerializer(serializers.ModelSerializer):
    account = OrgRelatedField(Account, extra_filter={"is_group": False, "is_active": True})
    account_code = serializers.CharField(source="account.code", read_only=True)
    account_name = serializers.CharField(source="account.name", read_only=True)
    customer = OrgRelatedField(Customer, required=False, allow_null=True)
    supplier = OrgRelatedField(Supplier, required=False, allow_null=True)
    customer_name = serializers.CharField(source="customer.name", read_only=True, default=None)
    supplier_name = serializers.CharField(source="supplier.name", read_only=True, default=None)

    class Meta:
        model = JournalLine
        fields = ["id", "line_no", "account", "account_code", "account_name", "debit", "credit", "description", "customer",
                  "customer_name", "supplier", "supplier_name", "cleared_date"]
        read_only_fields = ["line_no", "cleared_date"]

    def validate(self, attrs):
        debit, credit = attrs.get("debit", 0), attrs.get("credit", 0)
        if debit < 0 or credit < 0:
            raise serializers.ValidationError("Amounts cannot be negative.")
        if (debit > 0) == (credit > 0):
            raise serializers.ValidationError("Enter either a debit or a credit on each line.")
        return attrs


class JournalEntrySerializer(BaseModelSerializer):
    lines = JournalLineSerializer(many=True)
    source_label = serializers.CharField(source="get_source_display", read_only=True)
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    fiscal_year_name = serializers.CharField(source="fiscal_year.name", read_only=True, default=None)
    period_name = serializers.CharField(source="period.name", read_only=True, default=None)
    posted_by_name = serializers.CharField(source="posted_by.full_name", read_only=True, default=None)
    created_by_name = serializers.CharField(source="created_by.full_name", read_only=True, default=None)
    reversal_of_number = serializers.CharField(source="reversal_of.number", read_only=True, default=None)
    reversed_by = serializers.SerializerMethodField()
    source_link = serializers.SerializerMethodField()

    class Meta:
        model = JournalEntry
        fields = ["id", "number", "date", "fiscal_year", "fiscal_year_name", "period", "period_name", "narration", "source",
                  "source_label", "source_id", "source_number", "source_link", "status", "status_label", "posted_by_name",
                  "posted_at", "created_by_name", "reversal_of", "reversal_of_number", "reversed_by", "reversal_reason",
                  "total_debit", "total_credit", "lines", "created_at"]
        read_only_fields = ["number", "fiscal_year", "period", "source_id", "source_number", "status", "posted_at",
                            "reversal_of", "reversal_reason", "total_debit", "total_credit"]

    def get_reversed_by(self, obj):
        rev = getattr(obj, "reversed_by", None)
        return {"id": rev.pk, "number": rev.number} if rev else None

    def get_source_link(self, obj):
        from .ledgers import SOURCE_LINKS

        return SOURCE_LINKS.get(obj.source)

    def validate_source(self, value):
        if value not in (JournalSource.MANUAL, JournalSource.OPENING):
            raise serializers.ValidationError("Only manual and opening-balance journals are entered directly.")
        return value

    def validate(self, attrs):
        attrs = super().validate(attrs)
        if "lines" in attrs and len(attrs["lines"]) < 2:
            raise serializers.ValidationError({"lines": ["Add at least two lines."]})
        return attrs

    def _write_lines(self, entry, lines):
        entry.lines.all().delete()
        JournalLine.objects.bulk_create(JournalLine(entry=entry, line_no=i, **data) for i, data in enumerate(lines, 1))
        entry.total_debit = sum((l["debit"] for l in lines), 0)
        entry.total_credit = sum((l["credit"] for l in lines), 0)
        entry.save(update_fields=["total_debit", "total_credit"])

    def create(self, validated_data):
        from apps.fiscal_years.models import AccountingPeriod
        from apps.core.exceptions import BusinessRuleError

        lines = validated_data.pop("lines")
        organization = validated_data["organization"]
        period = AccountingPeriod.objects.select_related("fiscal_year").filter(
            fiscal_year__organization=organization, start_date__lte=validated_data["date"],
            end_date__gte=validated_data["date"]).first()
        if period is None:
            raise BusinessRuleError("No accounting period covers this date.", "no_period")
        entry = JournalEntry.objects.create(fiscal_year=period.fiscal_year, period=period, **validated_data)
        self._write_lines(entry, lines)
        return entry

    def update(self, instance, validated_data):
        from apps.fiscal_years.models import AccountingPeriod
        from apps.core.exceptions import BusinessRuleError

        if instance.status != "DRAFT":
            raise BusinessRuleError("Posted journals cannot be edited; reverse them instead.", "not_editable")
        lines = validated_data.pop("lines", None)
        for key, value in validated_data.items():
            setattr(instance, key, value)
        period = AccountingPeriod.objects.filter(fiscal_year__organization=instance.organization,
                                                 start_date__lte=instance.date, end_date__gte=instance.date).first()
        if period is None:
            raise BusinessRuleError("No accounting period covers this date.", "no_period")
        instance.period = period
        instance.fiscal_year_id = period.fiscal_year_id
        instance.save()
        if lines is not None:
            self._write_lines(instance, lines)
        return instance


class JournalListSerializer(BaseModelSerializer):
    source_label = serializers.CharField(source="get_source_display", read_only=True)

    class Meta:
        model = JournalEntry
        fields = ["id", "number", "date", "narration", "source", "source_label", "source_id", "source_number", "status",
                  "total_debit", "total_credit", "fiscal_year", "created_at"]


class ReconciliationSerializer(BaseModelSerializer):
    account_name = serializers.CharField(source="account.__str__", read_only=True)
    created_by_name = serializers.CharField(source="created_by.full_name", read_only=True, default=None)
    cleared_count = serializers.IntegerField(read_only=True, default=None)

    class Meta:
        model = BankReconciliation
        fields = ["id", "account", "account_name", "statement_date", "statement_balance", "book_balance", "cleared_balance",
                  "difference", "notes", "created_by_name", "cleared_count", "created_at"]
