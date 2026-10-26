"""General-ledger posting. Every financial document posts through ``post_journal``.

Guarantees:
* lines are validated (non-negative, one side, active postable accounts of the same organisation);
* Σ debit = Σ credit (also enforced by a deferred database trigger and a check constraint);
* the period is open (``get_posting_period``) and the fiscal year/period are recorded on the entry;
* idempotency: an ``idempotency_key`` (e.g. ``SI:42``) is unique per organisation, so posting the
  same source twice returns a conflict instead of a duplicate journal;
* AR/AP lines carry the customer/supplier so party ledgers are derived from the GL.
"""
from dataclasses import dataclass, field
from decimal import Decimal

from django.db import IntegrityError, transaction
from django.db.models import Q, Sum
from django.utils import timezone

from apps.core.exceptions import BusinessRuleError
from apps.core.money import ZERO, money
from apps.core.numbering import next_number
from apps.fiscal_years.services import get_posting_period

from .models import Account, JournalEntry, JournalLine, JournalSource, JournalStatus, SystemAccount


@dataclass
class Line:
    account: Account
    debit: Decimal = ZERO
    credit: Decimal = ZERO
    description: str = ""
    customer: object = None
    supplier: object = None
    extra: dict = field(default_factory=dict)


def system_account(organization, key) -> Account:
    try:
        return Account.objects.get(organization=organization, system_key=key)
    except Account.DoesNotExist:
        raise BusinessRuleError(f"System account '{key}' is not configured for this organisation.", "missing_account")


def _merge(lines):
    """Combine lines with the same account/party/side and drop zero lines."""
    merged = {}
    for line in lines:
        # A negative amount on one side is equivalent to a positive amount on the other.
        net = money(line.debit) - money(line.credit)
        if net == 0:
            continue
        key = (line.account.pk, getattr(line.customer, "pk", None), getattr(line.supplier, "pk", None),
               "D" if net > 0 else "C", line.description)
        if key in merged:
            merged[key].debit += net if net > 0 else ZERO
            merged[key].credit += -net if net < 0 else ZERO
        else:
            merged[key] = Line(line.account, net if net > 0 else ZERO, -net if net < 0 else ZERO,
                               line.description, line.customer, line.supplier)
    return list(merged.values())


def post_journal(organization, *, date, lines, source=JournalSource.MANUAL, source_id=None, source_number="",
                 narration="", user=None, idempotency_key="", reversal_of=None, reversal_reason="",
                 allow_closed_fiscal_year=False):
    """Create and post a balanced journal entry. Must be called inside a transaction."""
    lines = _merge(lines)
    if not lines:
        raise BusinessRuleError("A journal entry needs at least one non-zero line.")
    total_debit = sum((line.debit for line in lines), ZERO)
    total_credit = sum((line.credit for line in lines), ZERO)
    if total_debit != total_credit:
        raise BusinessRuleError(f"Journal is not balanced: debit {total_debit} ≠ credit {total_credit}.", "unbalanced")
    for line in lines:
        account = line.account
        if account.organization_id != organization.id:
            raise BusinessRuleError("An account does not belong to this organisation.")
        if account.is_group or not account.is_active:
            raise BusinessRuleError(f"Account {account} cannot be posted to (group or inactive).")
        if account.system_key == SystemAccount.RECEIVABLE and line.customer is None:
            raise BusinessRuleError(f"Lines on {account} must name a customer.")
        if account.system_key == SystemAccount.PAYABLE and line.supplier is None:
            raise BusinessRuleError(f"Lines on {account} must name a supplier.")

    if allow_closed_fiscal_year:
        from apps.fiscal_years.models import AccountingPeriod

        period = AccountingPeriod.objects.select_related("fiscal_year").get(
            fiscal_year__organization=organization, start_date__lte=date, end_date__gte=date
        )
    else:
        period = get_posting_period(organization, date)

    if idempotency_key and JournalEntry.objects.filter(organization=organization, idempotency_key=idempotency_key).exists():
        raise BusinessRuleError(f"This document has already been posted ({idempotency_key}).", "duplicate_posting")

    entry = JournalEntry(
        organization=organization,
        number=next_number(organization, "JV", date),
        date=date,
        fiscal_year=period.fiscal_year,
        period=period,
        narration=narration,
        source=source,
        source_id=source_id,
        source_number=source_number,
        idempotency_key=idempotency_key,
        status=JournalStatus.POSTED,
        posted_by=user,
        posted_at=timezone.now(),
        created_by=user,
        reversal_of=reversal_of,
        reversal_reason=reversal_reason,
        total_debit=total_debit,
        total_credit=total_credit,
    )
    try:
        with transaction.atomic():
            entry.save()
    except IntegrityError:
        raise BusinessRuleError(f"This document has already been posted ({idempotency_key}).", "duplicate_posting")
    JournalLine.objects.bulk_create(
        JournalLine(entry=entry, line_no=index, account=line.account, debit=line.debit, credit=line.credit,
                    description=line.description[:255], customer=line.customer, supplier=line.supplier)
        for index, line in enumerate(lines, 1)
    )
    return entry


def reverse_journal(entry, *, date, user, reason, allow_closed_fiscal_year=False):
    """Post the mirror image of ``entry`` on ``date`` and mark the original as reversed."""
    entry = JournalEntry.objects.select_for_update().get(pk=entry.pk)
    if entry.status == JournalStatus.REVERSED:
        raise BusinessRuleError(f"Journal {entry.number} has already been reversed.", "already_reversed")
    if JournalEntry.objects.filter(reversal_of=entry).exists():
        raise BusinessRuleError(f"Journal {entry.number} has already been reversed.", "already_reversed")
    if entry.status != JournalStatus.POSTED:
        raise BusinessRuleError("Only posted journals can be reversed.")
    lines = [
        Line(l.account, debit=l.credit, credit=l.debit, description=f"Reversal: {l.description}"[:255],
             customer=l.customer, supplier=l.supplier)
        for l in entry.lines.select_related("account", "customer", "supplier")
    ]
    reversal = post_journal(
        entry.organization, date=date, lines=lines, source=JournalSource.REVERSAL, source_id=entry.pk,
        source_number=entry.number, narration=f"Reversal of {entry.number}: {reason}", user=user,
        idempotency_key=f"REV:{entry.pk}", reversal_of=entry, reversal_reason=reason,
        allow_closed_fiscal_year=allow_closed_fiscal_year,
    )
    entry.status = JournalStatus.REVERSED
    entry.save(update_fields=["status", "updated_at"])
    return reversal


def posted_lines(organization):
    return JournalLine.objects.filter(
        entry__organization=organization, entry__status__in=[JournalStatus.POSTED, JournalStatus.REVERSED]
    )


def account_balance(account, *, start=None, end=None):
    """Debit-minus-credit movement of an account between optional inclusive dates."""
    qs = posted_lines(account.organization).filter(account=account)
    if start:
        qs = qs.filter(entry__date__gte=start)
    if end:
        qs = qs.filter(entry__date__lte=end)
    totals = qs.aggregate(d=Sum("debit"), c=Sum("credit"))
    return (totals["d"] or ZERO) - (totals["c"] or ZERO)


def party_balance(organization, *, customer=None, supplier=None, end=None, start=None):
    """Customer balance (debit-positive, AR) or supplier balance (credit-positive, AP)."""
    qs = posted_lines(organization)
    if customer is not None:
        qs = qs.filter(customer=customer, account__system_key=SystemAccount.RECEIVABLE)
    else:
        qs = qs.filter(supplier=supplier, account__system_key=SystemAccount.PAYABLE)
    if start:
        qs = qs.filter(entry__date__gte=start)
    if end:
        qs = qs.filter(entry__date__lte=end)
    totals = qs.aggregate(d=Sum("debit"), c=Sum("credit"))
    net = (totals["d"] or ZERO) - (totals["c"] or ZERO)
    return net if customer is not None else -net


def trial_balance(organization, *, start=None, end=None):
    """Per account: opening (before start), period debit/credit, closing. Excludes zero rows."""
    base = posted_lines(organization)
    rows = []
    period_filter = Q()
    if start:
        period_filter &= Q(entry__date__gte=start)
    if end:
        period_filter &= Q(entry__date__lte=end)
    opening = {}
    if start:
        for row in base.filter(entry__date__lt=start).values("account").annotate(d=Sum("debit"), c=Sum("credit")):
            opening[row["account"]] = (row["d"] or ZERO) - (row["c"] or ZERO)
    movement = {
        row["account"]: (row["d"] or ZERO, row["c"] or ZERO)
        for row in base.filter(period_filter).values("account").annotate(d=Sum("debit"), c=Sum("credit"))
    }
    for account in Account.objects.filter(organization=organization, is_group=False).order_by("code"):
        open_bal = opening.get(account.pk, ZERO)
        debit, credit = movement.get(account.pk, (ZERO, ZERO))
        closing = open_bal + debit - credit
        if open_bal == 0 and debit == 0 and credit == 0:
            continue
        rows.append({
            "account_id": account.pk, "code": account.code, "name": account.name, "type": account.account_type,
            "opening": open_bal, "debit": debit, "credit": credit, "closing": closing,
        })
    return rows


def post_draft_journal(entry, user):
    """Post a manual draft journal in place (keeps its id). Same rules as ``post_journal``."""
    entry = JournalEntry.objects.select_for_update().get(pk=entry.pk)
    if entry.status != JournalStatus.DRAFT:
        raise BusinessRuleError("This journal has already been posted.", "duplicate_posting")
    drafts = list(entry.lines.select_related("account", "customer", "supplier"))
    lines = _merge([Line(l.account, l.debit, l.credit, l.description, l.customer, l.supplier) for l in drafts])
    if len(lines) < 2:
        raise BusinessRuleError("A journal needs at least two lines.")
    total_debit = sum((l.debit for l in lines), ZERO)
    total_credit = sum((l.credit for l in lines), ZERO)
    if total_debit != total_credit:
        raise BusinessRuleError(f"Journal is not balanced: debit {total_debit} ≠ credit {total_credit}.", "unbalanced")
    for line in lines:
        account = line.account
        if account.organization_id != entry.organization_id or account.is_group or not account.is_active:
            raise BusinessRuleError(f"Account {account} cannot be posted to.")
        if account.system_key == SystemAccount.RECEIVABLE and line.customer is None:
            raise BusinessRuleError(f"Lines on {account} must name a customer.")
        if account.system_key == SystemAccount.PAYABLE and line.supplier is None:
            raise BusinessRuleError(f"Lines on {account} must name a supplier.")
    period = get_posting_period(entry.organization, entry.date)
    entry.lines.all().delete()
    JournalLine.objects.bulk_create(
        JournalLine(entry=entry, line_no=i, account=l.account, debit=l.debit, credit=l.credit,
                    description=l.description[:255], customer=l.customer, supplier=l.supplier)
        for i, l in enumerate(lines, 1)
    )
    entry.number = next_number(entry.organization, "JV", entry.date)
    entry.fiscal_year = period.fiscal_year
    entry.period = period
    entry.status = JournalStatus.POSTED
    entry.posted_by = user
    entry.posted_at = timezone.now()
    entry.total_debit = total_debit
    entry.total_credit = total_credit
    entry.idempotency_key = f"MJ:{entry.pk}"
    entry.save()
    return entry
