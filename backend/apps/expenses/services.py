"""Expense vouchers: draft → submitted → approved (posted) / rejected, and reversal.

Posting: Dr expense account (amount)  Dr VAT receivable (tax)  Cr cash/bank (total).
"""
from django.db import transaction
from django.utils import timezone

from apps.accounting.models import JournalSource, SystemAccount
from apps.accounting.services import Line, post_journal, reverse_journal, system_account
from apps.audit.services import record_event
from apps.core.exceptions import BusinessRuleError
from apps.core.money import ZERO, money
from apps.core.numbering import next_number
from apps.fiscal_years.services import get_posting_period

from .models import Expense, ExpenseStatus


def calculate(expense):
    expense.tax_percent = expense.tax_rate.rate if expense.tax_rate_id else ZERO
    expense.tax_amount = money(expense.amount * expense.tax_percent / 100)
    expense.total = money(expense.amount) + expense.tax_amount
    return expense


def _lock(expense):
    return Expense.objects.select_for_update().get(pk=expense.pk)


@transaction.atomic
def submit_expense(expense, user, request=None):
    expense = _lock(expense)
    if expense.status not in (ExpenseStatus.DRAFT, ExpenseStatus.REJECTED):
        raise BusinessRuleError("Only draft expenses can be submitted.")
    expense.status = ExpenseStatus.SUBMITTED
    expense.submitted_at = timezone.now()
    expense.rejection_reason = ""
    expense.save()
    record_event(request or user, "expense.submitted", "expense", expense, organization=expense.organization)
    if not expense.organization.require_expense_approval:
        return approve_expense(expense, user, request=request)
    return expense


@transaction.atomic
def approve_expense(expense, user, request=None):
    expense = _lock(expense)
    if expense.status != ExpenseStatus.SUBMITTED:
        raise BusinessRuleError("Only submitted expenses can be approved.", "duplicate_posting")
    organization = expense.organization
    account = expense.paid_from_account
    if not (account.is_cash or account.is_bank) or not account.is_active:
        raise BusinessRuleError("Pay expenses from an active cash or bank account.")
    calculate(expense)
    period = get_posting_period(organization, expense.date)
    expense.number = next_number(organization, "EX", expense.date)
    expense.fiscal_year = period.fiscal_year
    expense.journal = post_journal(
        organization, date=expense.date, source=JournalSource.EXPENSE, source_id=expense.pk, source_number=expense.number,
        user=user, idempotency_key=f"EX:{expense.pk}", narration=f"Expense {expense.number} – {expense.payee}: {expense.description}"[:500],
        lines=[Line(expense.category.account, debit=expense.amount, description=expense.category.name),
               Line(system_account(organization, SystemAccount.TAX_RECEIVABLE), debit=expense.tax_amount),
               Line(account, credit=expense.total)],
    )
    expense.status = ExpenseStatus.POSTED
    expense.approved_by = user
    expense.approved_at = timezone.now()
    expense.save()
    record_event(request or user, "expense.approved", "expense", expense, organization=organization,
                 new={"total": str(expense.total)})
    return expense


@transaction.atomic
def reject_expense(expense, user, reason, request=None):
    expense = _lock(expense)
    if expense.status != ExpenseStatus.SUBMITTED:
        raise BusinessRuleError("Only submitted expenses can be rejected.")
    if not reason:
        raise BusinessRuleError("A rejection reason is required.")
    expense.status = ExpenseStatus.REJECTED
    expense.rejection_reason = reason
    expense.save()
    record_event(request or user, "expense.rejected", "expense", expense, reason=reason, organization=expense.organization)
    return expense


@transaction.atomic
def reverse_expense(expense, user, reason, request=None):
    expense = _lock(expense)
    if expense.status != ExpenseStatus.POSTED:
        raise BusinessRuleError("Only posted expenses can be reversed.")
    if not reason:
        raise BusinessRuleError("A reason is required.")
    reverse_journal(expense.journal, date=max(timezone.localdate(), expense.date), user=user, reason=reason)
    expense.status = ExpenseStatus.REVERSED
    expense.reversal_reason = reason
    expense.save()
    record_event(request or user, "expense.reversed", "expense", expense, reason=reason, organization=expense.organization)
    return expense
