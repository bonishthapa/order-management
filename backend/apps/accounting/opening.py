"""Opening balances for customers and suppliers.

Posted once, through the ledger, against Opening Balance Equity. After posting the opening
balance fields are locked; later corrections are journals with an audit trail.
"""
from django.db import transaction

from apps.audit.services import record_event
from apps.core.exceptions import BusinessRuleError
from apps.core.money import money

from .models import JournalSource, SystemAccount
from .services import Line, post_journal, system_account


@transaction.atomic
def post_customer_opening_balance(customer, user, amount, date, request=None):
    from apps.customers.models import Customer

    customer = Customer.objects.select_for_update().get(pk=customer.pk)
    if customer.opening_balance_journal_id:
        raise BusinessRuleError("The opening balance has already been posted; use an adjustment journal.", "duplicate_posting")
    amount = money(amount)
    if amount == 0:
        raise BusinessRuleError("Enter a non-zero opening balance.")
    organization = customer.organization
    customer.opening_balance = amount
    customer.opening_balance_date = date
    customer.opening_balance_journal = post_journal(
        organization, date=date, source=JournalSource.OPENING, source_id=customer.pk, source_number=customer.code,
        user=user, idempotency_key=f"OB-C:{customer.pk}", narration=f"Opening balance – {customer.name}",
        lines=[Line(system_account(organization, SystemAccount.RECEIVABLE), debit=amount, customer=customer,
                    description="Opening balance"),
               Line(system_account(organization, SystemAccount.OPENING_EQUITY), credit=amount)],
    )
    customer.save()
    record_event(request or user, "customer.opening_balance_posted", "customer", customer, organization=organization,
                 new={"opening_balance": str(amount), "date": date.isoformat()})
    return customer


@transaction.atomic
def post_supplier_opening_balance(supplier, user, amount, date, request=None):
    from apps.suppliers.models import Supplier

    supplier = Supplier.objects.select_for_update().get(pk=supplier.pk)
    if supplier.opening_balance_journal_id:
        raise BusinessRuleError("The opening balance has already been posted; use an adjustment journal.", "duplicate_posting")
    amount = money(amount)
    if amount == 0:
        raise BusinessRuleError("Enter a non-zero opening balance.")
    organization = supplier.organization
    supplier.opening_balance = amount
    supplier.opening_balance_date = date
    supplier.opening_balance_journal = post_journal(
        organization, date=date, source=JournalSource.OPENING, source_id=supplier.pk, source_number=supplier.code,
        user=user, idempotency_key=f"OB-S:{supplier.pk}", narration=f"Opening balance – {supplier.name}",
        lines=[Line(system_account(organization, SystemAccount.OPENING_EQUITY), debit=amount),
               Line(system_account(organization, SystemAccount.PAYABLE), credit=amount, supplier=supplier,
                    description="Opening balance")],
    )
    supplier.save()
    record_event(request or user, "supplier.opening_balance_posted", "supplier", supplier, organization=organization,
                 new={"opening_balance": str(amount), "date": date.isoformat()})
    return supplier
