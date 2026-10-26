"""Receipts, payment vouchers, refunds, allocations and their reversals.

Ledger effect:
* Customer receipt:   Dr cash/bank           Cr AR (customer)
* Customer refund:    Dr AR (customer)       Cr cash/bank
* Payment voucher:    Dr AP (supplier)       Cr cash/bank
* Supplier refund:    Dr cash/bank           Cr AP (supplier)
Allocations only match documents; they never post to the ledger. Unallocated money stays on
the party's ledger as an advance (credit balance for customers, debit balance for suppliers).
"""
from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from apps.accounting.models import JournalSource, SystemAccount
from apps.accounting.services import Line, post_journal, reverse_journal, system_account
from apps.audit.services import record_event
from apps.core.exceptions import BusinessRuleError
from apps.core.money import ZERO, money
from apps.core.numbering import next_number
from apps.fiscal_years.services import get_posting_period
from apps.purchases.models import BillStatus, PurchaseReturn, SupplierBill
from apps.sales.models import InvoiceStatus, SalesInvoice, SalesReturn
from apps.sales.services import refresh_invoice_balance

from .models import (
    BillAllocation,
    CustomerReceipt,
    CustomerRefund,
    InvoiceAllocation,
    PaymentDocStatus,
    PaymentVoucher,
    SupplierRefund,
)


def _validate_cash_account(organization, account, method):
    if account.organization_id != organization.id or not (account.is_cash or account.is_bank) or not account.is_active:
        raise BusinessRuleError("Select an active cash or bank account.")
    if method.organization_id != organization.id or not method.is_active:
        raise BusinessRuleError("Select an active payment method.")


def _normalise_allocations(raw, model, organization, party_field, party):
    """[(doc_id or doc, amount)] -> [(locked doc, amount)] with duplicates merged."""
    totals = {}
    for doc, amount in raw:
        doc_id = getattr(doc, "pk", doc)
        amount = money(amount)
        if amount <= 0:
            raise BusinessRuleError("Allocation amounts must be positive.", "invalid_allocation")
        totals[int(doc_id)] = totals.get(int(doc_id), ZERO) + amount
    docs = {
        d.pk: d for d in model.objects.select_for_update().filter(pk__in=totals.keys(), organization=organization).order_by("pk")
    }
    result = []
    for doc_id, amount in totals.items():
        doc = docs.get(doc_id)
        if doc is None:
            raise BusinessRuleError("An allocated document was not found.", "invalid_allocation")
        if getattr(doc, f"{party_field}_id") != party.pk:
            raise BusinessRuleError(f"{doc} belongs to a different {party_field}.", "invalid_allocation")
        if doc.status not in (InvoiceStatus.POSTED, BillStatus.POSTED):
            raise BusinessRuleError(f"{doc} is not posted.", "invalid_allocation")
        if amount > doc.balance_due:
            raise BusinessRuleError(f"Allocation {amount} exceeds the outstanding balance {doc.balance_due} of {doc}.", "over_allocation")
        result.append((doc, amount))
    return result


# --- Customer receipts ------------------------------------------------------------------------


@transaction.atomic
def create_receipt(organization, user, *, customer, date, amount, payment_method, deposit_account, reference="",
                   notes="", allocations=(), request=None):
    amount = money(amount)
    if amount <= 0:
        raise BusinessRuleError("The amount received must be positive.")
    if customer.organization_id != organization.id:
        raise BusinessRuleError("Unknown customer.")
    _validate_cash_account(organization, deposit_account, payment_method)
    if payment_method.requires_reference and not reference:
        raise BusinessRuleError(f"{payment_method.name} payments need a transaction reference.")
    period = get_posting_period(organization, date)
    receipt = CustomerReceipt.objects.create(
        organization=organization, customer=customer, date=date, amount=amount, payment_method=payment_method,
        deposit_account=deposit_account, reference=reference, notes=notes, status=PaymentDocStatus.POSTED,
        received_by=user, created_by=user, fiscal_year=period.fiscal_year,
        number=next_number(organization, "RC", date),
    )
    receipt.journal = post_journal(
        organization, date=date, source=JournalSource.CUSTOMER_RECEIPT, source_id=receipt.pk, source_number=receipt.number,
        user=user, idempotency_key=f"RC:{receipt.pk}", narration=f"Receipt {receipt.number} from {customer.name}",
        lines=[Line(deposit_account, debit=amount),
               Line(system_account(organization, SystemAccount.RECEIVABLE), credit=amount, customer=customer,
                    description=f"Receipt {receipt.number}")],
    )
    receipt.save(update_fields=["journal"])
    if allocations:
        allocate_receipt(receipt, allocations, user, lock=False)
    record_event(request or user, "receipt.posted", "customerreceipt", receipt, organization=organization,
                 new={"amount": str(amount), "allocated": str(receipt.allocated_amount)})
    return receipt


@transaction.atomic
def allocate_receipt(receipt, allocations, user, lock=True, request=None):
    if lock:
        receipt = CustomerReceipt.objects.select_for_update().get(pk=receipt.pk)
    if receipt.status != PaymentDocStatus.POSTED:
        raise BusinessRuleError("Only posted receipts can be allocated.")
    items = _normalise_allocations(allocations, SalesInvoice, receipt.organization, "customer", receipt.customer)
    total = sum((amount for _, amount in items), ZERO)
    if total > receipt.unapplied_amount:
        raise BusinessRuleError(f"Allocations {total} exceed the unapplied amount {receipt.unapplied_amount}.", "over_allocation")
    for invoice, amount in items:
        InvoiceAllocation.objects.create(organization=receipt.organization, invoice=invoice, receipt=receipt, amount=amount,
                                         date=max(receipt.date, invoice.invoice_date), created_by=user)
        refresh_invoice_balance(invoice)
    receipt.allocated_amount += total
    receipt.save(update_fields=["allocated_amount", "updated_at"])
    if lock:
        record_event(request or user, "receipt.allocated", "customerreceipt", receipt, organization=receipt.organization,
                     new={str(inv.number): str(amt) for inv, amt in items})
    return receipt


@transaction.atomic
def allocate_credit_note(sales_return, allocations, user, lock=True, request=None):
    if lock:
        sales_return = SalesReturn.objects.select_for_update().get(pk=sales_return.pk)
    if sales_return.status != "POSTED":
        raise BusinessRuleError("Only posted credit notes can be applied.")
    items = _normalise_allocations(allocations, SalesInvoice, sales_return.organization, "customer", sales_return.customer)
    total = sum((amount for _, amount in items), ZERO)
    if total > sales_return.unapplied_credit:
        raise BusinessRuleError(f"Allocations {total} exceed the unapplied credit {sales_return.unapplied_credit}.", "over_allocation")
    for invoice, amount in items:
        InvoiceAllocation.objects.create(organization=sales_return.organization, invoice=invoice, credit_note=sales_return,
                                         amount=amount, date=max(sales_return.date, invoice.invoice_date), created_by=user)
        refresh_invoice_balance(invoice)
    sales_return.credit_applied += total
    sales_return.save(update_fields=["credit_applied", "updated_at"])
    if lock:
        record_event(request or user, "credit_note.applied", "salesreturn", sales_return, organization=sales_return.organization,
                     new={str(inv.number): str(amt) for inv, amt in items})
    return sales_return


@transaction.atomic
def reverse_receipt(receipt, user, reason, date=None, request=None):
    receipt = CustomerReceipt.objects.select_for_update().get(pk=receipt.pk)
    if receipt.status != PaymentDocStatus.POSTED:
        raise BusinessRuleError("Only posted receipts can be reversed.")
    if not reason:
        raise BusinessRuleError("A reason is required (e.g. cheque bounced).")
    if receipt.refunded_amount > 0:
        raise BusinessRuleError("Part of this receipt has been refunded; reverse the refund first.")
    date = date or max(timezone.localdate(), receipt.date)
    reverse_journal(receipt.journal, date=date, user=user, reason=reason)
    for allocation in receipt.allocations.select_for_update().filter(is_active=True):
        allocation.is_active = False
        allocation.reversed_at = timezone.now()
        allocation.save(update_fields=["is_active", "reversed_at"])
        refresh_invoice_balance(SalesInvoice.objects.select_for_update().get(pk=allocation.invoice_id))
    receipt.status = PaymentDocStatus.REVERSED
    receipt.allocated_amount = ZERO
    receipt.reversal_reason = reason
    receipt.reversed_at = timezone.now()
    receipt.save()
    record_event(request or user, "receipt.reversed", "customerreceipt", receipt, reason=reason, organization=receipt.organization)
    return receipt


@transaction.atomic
def create_customer_refund(organization, user, *, customer, date, amount, payment_method, paid_from_account,
                           receipt=None, credit_note=None, reference="", notes="", request=None):
    amount = money(amount)
    if amount <= 0:
        raise BusinessRuleError("The refund amount must be positive.")
    if (receipt is None) == (credit_note is None):
        raise BusinessRuleError("Refund either an unapplied receipt or an unapplied credit note.")
    _validate_cash_account(organization, paid_from_account, payment_method)
    if receipt is not None:
        source = CustomerReceipt.objects.select_for_update().get(pk=receipt.pk, organization=organization)
        available = source.unapplied_amount if source.status == PaymentDocStatus.POSTED else ZERO
    else:
        source = SalesReturn.objects.select_for_update().get(pk=credit_note.pk, organization=organization)
        available = source.unapplied_credit if source.status == "POSTED" else ZERO
    if source.customer_id != customer.pk:
        raise BusinessRuleError("The refunded document belongs to another customer.")
    if amount > available:
        raise BusinessRuleError(f"Refund {amount} exceeds the unapplied amount {available}.", "over_allocation")
    get_posting_period(organization, date)
    refund = CustomerRefund.objects.create(
        organization=organization, customer=customer, date=date, amount=amount, receipt=receipt, credit_note=credit_note,
        payment_method=payment_method, paid_from_account=paid_from_account, reference=reference, notes=notes,
        created_by=user, number=next_number(organization, "RF", date),
    )
    refund.journal = post_journal(
        organization, date=date, source=JournalSource.CUSTOMER_REFUND, source_id=refund.pk, source_number=refund.number,
        user=user, idempotency_key=f"RF:{refund.pk}", narration=f"Refund {refund.number} to {customer.name}",
        lines=[Line(system_account(organization, SystemAccount.RECEIVABLE), debit=amount, customer=customer,
                    description=f"Refund {refund.number}"),
               Line(paid_from_account, credit=amount)],
    )
    refund.save(update_fields=["journal"])
    source.refunded_amount += amount
    source.save(update_fields=["refunded_amount", "updated_at"])
    record_event(request or user, "customer_refund.posted", "customerrefund", refund, organization=organization)
    return refund


# --- Supplier payments ------------------------------------------------------------------------


@transaction.atomic
def post_voucher(voucher, user, request=None):
    voucher = PaymentVoucher.objects.select_for_update().get(pk=voucher.pk)
    if voucher.status != PaymentDocStatus.DRAFT:
        raise BusinessRuleError("This voucher has already been posted.", "duplicate_posting")
    organization = voucher.organization
    _validate_cash_account(organization, voucher.paid_from_account, voucher.payment_method)
    if voucher.payment_method.requires_reference and not voucher.reference:
        raise BusinessRuleError(f"{voucher.payment_method.name} payments need a transaction reference.")
    if not voucher.supplier.is_active:
        raise BusinessRuleError(f"Supplier {voucher.supplier} is inactive.")
    period = get_posting_period(organization, voucher.date)
    voucher.number = next_number(organization, "PV", voucher.date)
    voucher.fiscal_year = period.fiscal_year
    voucher.journal = post_journal(
        organization, date=voucher.date, source=JournalSource.PAYMENT_VOUCHER, source_id=voucher.pk,
        source_number=voucher.number, user=user, idempotency_key=f"PV:{voucher.pk}",
        narration=f"Payment voucher {voucher.number} to {voucher.supplier.name}",
        lines=[Line(system_account(organization, SystemAccount.PAYABLE), debit=voucher.amount, supplier=voucher.supplier,
                    description=f"Payment {voucher.number}"),
               Line(voucher.paid_from_account, credit=voucher.amount)],
    )
    voucher.status = PaymentDocStatus.POSTED
    voucher.approved_by = user
    voucher.approved_at = timezone.now()
    voucher.save()
    requested = [(item["bill"], item["amount"]) for item in voucher.requested_allocations or []]
    if requested:
        allocate_voucher(voucher, requested, user, lock=False)
    record_event(request or user, "payment_voucher.posted", "paymentvoucher", voucher, organization=organization,
                 new={"amount": str(voucher.amount), "allocated": str(voucher.allocated_amount)})
    return voucher


def refresh_bill_balance(bill):
    active = BillAllocation.objects.filter(bill=bill, is_active=True)
    paid = active.filter(voucher__isnull=False).aggregate(s=Sum("amount"))["s"] or ZERO
    credited = active.filter(debit_note__isnull=False).aggregate(s=Sum("amount"))["s"] or ZERO
    bill.amount_paid = paid
    bill.amount_credited = credited
    bill.balance_due = bill.grand_total - paid - credited
    if bill.balance_due < 0:
        raise BusinessRuleError(f"Allocations exceed the total of bill {bill.number}.", "over_allocation")
    bill.payment_status = "PAID" if bill.balance_due == 0 else ("PARTIAL" if paid + credited > 0 else "UNPAID")
    bill.save(update_fields=["amount_paid", "amount_credited", "balance_due", "payment_status", "updated_at"])
    return bill


@transaction.atomic
def allocate_voucher(voucher, allocations, user, lock=True, request=None):
    if lock:
        voucher = PaymentVoucher.objects.select_for_update().get(pk=voucher.pk)
    if voucher.status != PaymentDocStatus.POSTED:
        raise BusinessRuleError("Only posted vouchers can be allocated.")
    items = _normalise_allocations(allocations, SupplierBill, voucher.organization, "supplier", voucher.supplier)
    total = sum((amount for _, amount in items), ZERO)
    if total > voucher.unapplied_amount:
        raise BusinessRuleError(f"Allocations {total} exceed the unapplied amount {voucher.unapplied_amount}.", "over_allocation")
    for bill, amount in items:
        BillAllocation.objects.create(organization=voucher.organization, bill=bill, voucher=voucher, amount=amount,
                                      date=max(voucher.date, bill.bill_date), created_by=user)
        refresh_bill_balance(bill)
    voucher.allocated_amount += total
    voucher.save(update_fields=["allocated_amount", "updated_at"])
    if lock:
        record_event(request or user, "payment_voucher.allocated", "paymentvoucher", voucher, organization=voucher.organization,
                     new={str(b.number): str(a) for b, a in items})
    return voucher


@transaction.atomic
def allocate_debit_note(purchase_return, allocations, user, lock=True, request=None):
    if lock:
        purchase_return = PurchaseReturn.objects.select_for_update().get(pk=purchase_return.pk)
    if purchase_return.status != "POSTED":
        raise BusinessRuleError("Only posted debit notes can be applied.")
    items = _normalise_allocations(allocations, SupplierBill, purchase_return.organization, "supplier", purchase_return.supplier)
    total = sum((amount for _, amount in items), ZERO)
    if total > purchase_return.unapplied_credit:
        raise BusinessRuleError(f"Allocations {total} exceed the unapplied debit note {purchase_return.unapplied_credit}.", "over_allocation")
    for bill, amount in items:
        BillAllocation.objects.create(organization=purchase_return.organization, bill=bill, debit_note=purchase_return,
                                      amount=amount, date=max(purchase_return.date, bill.bill_date), created_by=user)
        refresh_bill_balance(bill)
    purchase_return.credit_applied += total
    purchase_return.save(update_fields=["credit_applied", "updated_at"])
    return purchase_return


@transaction.atomic
def reverse_voucher(voucher, user, reason, date=None, request=None):
    voucher = PaymentVoucher.objects.select_for_update().get(pk=voucher.pk)
    if voucher.status != PaymentDocStatus.POSTED:
        raise BusinessRuleError("Only posted vouchers can be reversed.")
    if not reason:
        raise BusinessRuleError("A reason is required.")
    if voucher.refunded_amount > 0:
        raise BusinessRuleError("Part of this payment has been refunded; reverse the refund first.")
    date = date or max(timezone.localdate(), voucher.date)
    reverse_journal(voucher.journal, date=date, user=user, reason=reason)
    for allocation in voucher.allocations.select_for_update().filter(is_active=True):
        allocation.is_active = False
        allocation.reversed_at = timezone.now()
        allocation.save(update_fields=["is_active", "reversed_at"])
        refresh_bill_balance(SupplierBill.objects.select_for_update().get(pk=allocation.bill_id))
    voucher.status = PaymentDocStatus.REVERSED
    voucher.allocated_amount = ZERO
    voucher.reversal_reason = reason
    voucher.reversed_at = timezone.now()
    voucher.save()
    record_event(request or user, "payment_voucher.reversed", "paymentvoucher", voucher, reason=reason, organization=voucher.organization)
    return voucher


@transaction.atomic
def create_supplier_refund(organization, user, *, supplier, date, amount, payment_method, deposit_account,
                           voucher=None, debit_note=None, reference="", notes="", request=None):
    amount = money(amount)
    if amount <= 0:
        raise BusinessRuleError("The refund amount must be positive.")
    if (voucher is None) == (debit_note is None):
        raise BusinessRuleError("Refund either an unapplied payment or an unapplied debit note.")
    _validate_cash_account(organization, deposit_account, payment_method)
    if voucher is not None:
        source = PaymentVoucher.objects.select_for_update().get(pk=voucher.pk, organization=organization)
        available = source.unapplied_amount if source.status == PaymentDocStatus.POSTED else ZERO
    else:
        source = PurchaseReturn.objects.select_for_update().get(pk=debit_note.pk, organization=organization)
        available = source.unapplied_credit if source.status == "POSTED" else ZERO
    if source.supplier_id != supplier.pk:
        raise BusinessRuleError("The refunded document belongs to another supplier.")
    if amount > available:
        raise BusinessRuleError(f"Refund {amount} exceeds the unapplied amount {available}.", "over_allocation")
    get_posting_period(organization, date)
    refund = SupplierRefund.objects.create(
        organization=organization, supplier=supplier, date=date, amount=amount, voucher=voucher, debit_note=debit_note,
        payment_method=payment_method, deposit_account=deposit_account, reference=reference, notes=notes,
        created_by=user, number=next_number(organization, "RF", date),
    )
    refund.journal = post_journal(
        organization, date=date, source=JournalSource.SUPPLIER_REFUND, source_id=refund.pk, source_number=refund.number,
        user=user, idempotency_key=f"SRF:{refund.pk}", narration=f"Refund {refund.number} from {supplier.name}",
        lines=[Line(deposit_account, debit=amount),
               Line(system_account(organization, SystemAccount.PAYABLE), credit=amount, supplier=supplier,
                    description=f"Refund {refund.number}")],
    )
    refund.save(update_fields=["journal"])
    source.refunded_amount += amount
    source.save(update_fields=["refunded_amount", "updated_at"])
    record_event(request or user, "supplier_refund.posted", "supplierrefund", refund, organization=organization)
    return refund
