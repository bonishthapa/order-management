from rest_framework import serializers

from apps.accounting.models import Account
from apps.core.serializers import AllocationItemSerializer, BaseModelSerializer, OrgRelatedField
from apps.customers.models import Customer
from apps.organizations.models import PaymentMethod
from apps.purchases.models import PurchaseReturn
from apps.sales.models import SalesReturn
from apps.suppliers.models import Supplier

from .models import CustomerReceipt, CustomerRefund, PaymentVoucher, SupplierRefund

CASH_BANK = {"is_group": False, "is_active": True}


class InvoiceAllocationReadSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    invoice = serializers.IntegerField(source="invoice_id")
    invoice_number = serializers.CharField(source="invoice.number")
    invoice_date = serializers.DateField(source="invoice.invoice_date")
    invoice_total = serializers.DecimalField(source="invoice.grand_total", max_digits=18, decimal_places=2)
    amount = serializers.DecimalField(max_digits=18, decimal_places=2)
    date = serializers.DateField()
    is_active = serializers.BooleanField()


class CustomerReceiptSerializer(BaseModelSerializer):
    customer = OrgRelatedField(Customer)
    payment_method = OrgRelatedField(PaymentMethod, extra_filter={"is_active": True})
    deposit_account = OrgRelatedField(Account, extra_filter=CASH_BANK)
    customer_name = serializers.CharField(source="customer.name", read_only=True)
    payment_method_name = serializers.CharField(source="payment_method.name", read_only=True)
    deposit_account_name = serializers.CharField(source="deposit_account.__str__", read_only=True)
    received_by_name = serializers.CharField(source="received_by.full_name", read_only=True, default=None)
    unapplied_amount = serializers.DecimalField(max_digits=18, decimal_places=2, read_only=True)
    allocations = InvoiceAllocationReadSerializer(many=True, read_only=True)
    allocate = AllocationItemSerializer(many=True, write_only=True, required=False)
    journal_number = serializers.CharField(source="journal.number", read_only=True, default=None)
    fiscal_year_name = serializers.CharField(source="fiscal_year.name", read_only=True, default=None)

    class Meta:
        model = CustomerReceipt
        fields = ["id", "number", "fiscal_year", "fiscal_year_name", "customer", "customer_name", "date", "amount", "payment_method",
                  "payment_method_name", "deposit_account", "deposit_account_name", "reference", "notes", "status",
                  "allocated_amount", "refunded_amount", "unapplied_amount", "allocations", "allocate", "received_by_name",
                  "journal", "journal_number", "reversal_reason", "reversed_at", "print_count", "created_at"]
        read_only_fields = ["number", "fiscal_year", "status", "allocated_amount", "refunded_amount", "journal",
                            "reversal_reason", "reversed_at", "print_count"]

    def validate(self, attrs):
        attrs = super().validate(attrs)
        account = attrs.get("deposit_account")
        if account and not (account.is_cash or account.is_bank):
            raise serializers.ValidationError({"deposit_account": ["Choose a cash or bank account."]})
        if attrs.get("amount") is not None and attrs["amount"] <= 0:
            raise serializers.ValidationError({"amount": ["The amount must be greater than zero."]})
        return attrs


class CustomerRefundSerializer(BaseModelSerializer):
    customer = OrgRelatedField(Customer)
    receipt = OrgRelatedField(CustomerReceipt, required=False, allow_null=True)
    credit_note = OrgRelatedField(SalesReturn, required=False, allow_null=True)
    payment_method = OrgRelatedField(PaymentMethod, extra_filter={"is_active": True})
    paid_from_account = OrgRelatedField(Account, extra_filter=CASH_BANK)
    customer_name = serializers.CharField(source="customer.name", read_only=True)
    source_number = serializers.SerializerMethodField()

    class Meta:
        model = CustomerRefund
        fields = ["id", "number", "customer", "customer_name", "date", "amount", "receipt", "credit_note", "source_number",
                  "payment_method", "paid_from_account", "reference", "notes", "status", "journal", "created_at"]
        read_only_fields = ["number", "status", "journal"]

    def get_source_number(self, obj):
        return (obj.receipt or obj.credit_note).number


class BillAllocationReadSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    bill = serializers.IntegerField(source="bill_id")
    bill_number = serializers.CharField(source="bill.number")
    supplier_invoice_number = serializers.CharField(source="bill.supplier_invoice_number")
    bill_date = serializers.DateField(source="bill.bill_date")
    bill_total = serializers.DecimalField(source="bill.grand_total", max_digits=18, decimal_places=2)
    amount = serializers.DecimalField(max_digits=18, decimal_places=2)
    date = serializers.DateField()
    is_active = serializers.BooleanField()


class PaymentVoucherSerializer(BaseModelSerializer):
    supplier = OrgRelatedField(Supplier)
    payment_method = OrgRelatedField(PaymentMethod, extra_filter={"is_active": True})
    paid_from_account = OrgRelatedField(Account, extra_filter=CASH_BANK)
    supplier_name = serializers.CharField(source="supplier.name", read_only=True)
    payment_method_name = serializers.CharField(source="payment_method.name", read_only=True)
    paid_from_account_name = serializers.CharField(source="paid_from_account.__str__", read_only=True)
    prepared_by_name = serializers.CharField(source="prepared_by.full_name", read_only=True, default=None)
    approved_by_name = serializers.CharField(source="approved_by.full_name", read_only=True, default=None)
    unapplied_amount = serializers.DecimalField(max_digits=18, decimal_places=2, read_only=True)
    allocations = BillAllocationReadSerializer(many=True, read_only=True)
    allocate = AllocationItemSerializer(many=True, write_only=True, required=False)
    journal_number = serializers.CharField(source="journal.number", read_only=True, default=None)
    fiscal_year_name = serializers.CharField(source="fiscal_year.name", read_only=True, default=None)

    class Meta:
        model = PaymentVoucher
        fields = ["id", "number", "fiscal_year", "fiscal_year_name", "supplier", "supplier_name", "date", "amount", "payment_method",
                  "payment_method_name", "paid_from_account", "paid_from_account_name", "reference", "notes", "status",
                  "allocated_amount", "refunded_amount", "unapplied_amount", "requested_allocations", "allocations",
                  "allocate", "prepared_by_name", "approved_by_name", "approved_at", "journal", "journal_number",
                  "reversal_reason", "reversed_at", "print_count", "created_at"]
        read_only_fields = ["number", "fiscal_year", "status", "allocated_amount", "refunded_amount",
                            "requested_allocations", "approved_at", "journal", "reversal_reason", "reversed_at", "print_count"]

    def validate(self, attrs):
        from apps.purchases.models import SupplierBill

        attrs = super().validate(attrs)
        account = attrs.get("paid_from_account")
        if account and not (account.is_cash or account.is_bank):
            raise serializers.ValidationError({"paid_from_account": ["Choose a cash or bank account."]})
        amount = attrs.get("amount", getattr(self.instance, "amount", None))
        if amount is not None and amount <= 0:
            raise serializers.ValidationError({"amount": ["The amount must be greater than zero."]})
        supplier = attrs.get("supplier") or getattr(self.instance, "supplier", None)
        allocate = attrs.pop("allocate", None)
        if allocate is not None:
            total = sum((a["amount"] for a in allocate), 0)
            if total > amount:
                raise serializers.ValidationError({"allocate": [f"Allocations {total} exceed the payment amount {amount}."]})
            for item in allocate:
                bill = SupplierBill.objects.filter(pk=item["document"], organization=self.organization, supplier=supplier,
                                                   status="POSTED").first()
                if bill is None:
                    raise serializers.ValidationError({"allocate": ["Allocate only to this supplier's posted bills."]})
                if item["amount"] > bill.balance_due:
                    raise serializers.ValidationError({"allocate": [f"{bill.number}: at most {bill.balance_due} is outstanding."]})
            attrs["requested_allocations"] = [{"bill": a["document"], "amount": str(a["amount"])} for a in allocate if a["amount"] > 0]
        return attrs


class SupplierRefundSerializer(BaseModelSerializer):
    supplier = OrgRelatedField(Supplier)
    voucher = OrgRelatedField(PaymentVoucher, required=False, allow_null=True)
    debit_note = OrgRelatedField(PurchaseReturn, required=False, allow_null=True)
    payment_method = OrgRelatedField(PaymentMethod, extra_filter={"is_active": True})
    deposit_account = OrgRelatedField(Account, extra_filter=CASH_BANK)
    supplier_name = serializers.CharField(source="supplier.name", read_only=True)
    payment_method_name = serializers.CharField(source="payment_method.name", read_only=True)
    deposit_account_name = serializers.CharField(source="deposit_account.__str__", read_only=True)
    source_number = serializers.SerializerMethodField()
    journal_number = serializers.CharField(source="journal.number", read_only=True, default=None)

    class Meta:
        model = SupplierRefund
        fields = ["id", "number", "supplier", "supplier_name", "date", "amount", "voucher", "debit_note", "source_number",
                  "payment_method", "payment_method_name", "deposit_account", "deposit_account_name", "reference", "notes",
                  "status", "journal", "journal_number", "created_at"]
        read_only_fields = ["number", "status", "journal"]

    def get_source_number(self, obj):
        source = obj.voucher or obj.debit_note
        return source.number if source else None
