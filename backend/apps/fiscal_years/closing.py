"""Guided year-end close.

``preview`` runs every validation and returns blockers, warnings and the closing figures
without changing anything. ``close`` re-runs the preview inside a transaction that holds the
fiscal-year and period rows ``FOR UPDATE``, refuses to continue if any blocker exists, then:

1. posts a closing journal on the last day of the year that moves every income and expense
   account balance for the year into Retained Earnings;
2. locks every period and marks the year CLOSED;
3. marks the next fiscal year's opening balances as carried forward (balance-sheet accounts
   carry forward automatically because balances are cumulative);
4. stores the summary permanently in ``FiscalYearClosing``.

Nothing closes automatically when the end date passes.
"""
from decimal import Decimal

from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from apps.accounting.models import Account, AccountType, JournalEntry, JournalSource, JournalStatus, SystemAccount
from apps.accounting.services import Line, post_journal, posted_lines, reverse_journal, system_account
from apps.audit.services import record_event
from apps.core.exceptions import BusinessRuleError
from apps.core.money import ZERO

from .models import (
    AccountingPeriod,
    ClosingStatus,
    FiscalYear,
    FiscalYearClosing,
    FiscalYearStatus,
    OpeningBalanceStatus,
    PeriodStatus,
)


def _s(value):
    return str(value if value is not None else ZERO)


def _pending_documents(fiscal_year):
    from apps.expenses.models import Expense
    from apps.inventory.models import StockCount, StockMovement, StockTransfer
    from apps.payments.models import PaymentVoucher
    from apps.purchases.models import GoodsReceipt, PurchaseReturn, SupplierBill
    from apps.sales.models import Delivery, SalesInvoice, SalesReturn

    org = fiscal_year.organization
    rng = (fiscal_year.start_date, fiscal_year.end_date)
    checks = [
        ("Draft sales invoices", SalesInvoice.objects.filter(organization=org, status="DRAFT", invoice_date__range=rng)),
        ("Draft deliveries", Delivery.objects.filter(organization=org, status="DRAFT", date__range=rng)),
        ("Draft sales returns", SalesReturn.objects.filter(organization=org, status="DRAFT", date__range=rng)),
        ("Draft goods receipts", GoodsReceipt.objects.filter(organization=org, status="DRAFT", date__range=rng)),
        ("Draft supplier bills", SupplierBill.objects.filter(organization=org, status="DRAFT", bill_date__range=rng)),
        ("Draft purchase returns", PurchaseReturn.objects.filter(organization=org, status="DRAFT", date__range=rng)),
        ("Unposted payment vouchers", PaymentVoucher.objects.filter(organization=org, status="DRAFT", date__range=rng)),
        ("Unapproved expenses", Expense.objects.filter(organization=org, status__in=["DRAFT", "SUBMITTED"], date__range=rng)),
        ("Draft stock movements", StockMovement.objects.filter(organization=org, status="DRAFT", date__range=rng)),
        ("Draft stock counts", StockCount.objects.filter(organization=org, status="DRAFT", date__range=rng)),
        ("Draft journals", JournalEntry.objects.filter(organization=org, status=JournalStatus.DRAFT, date__range=rng)),
    ]
    blockers = []
    for label, qs in checks:
        count = qs.count()
        if count:
            blockers.append({"check": label, "count": count, "message": f"{count} {label.lower()} dated in this fiscal year."})
    in_transit = StockTransfer.objects.filter(organization=org, status="IN_TRANSIT", date__lte=fiscal_year.end_date).count()
    warnings = []
    if in_transit:
        warnings.append({"check": "Transfers in transit", "count": in_transit,
                         "message": f"{in_transit} stock transfer(s) are still in transit (valued in the transit warehouse)."})
    return blockers, warnings


def preview(fiscal_year):
    from apps.inventory.models import StockLedgerEntry

    org = fiscal_year.organization
    end = fiscal_year.end_date
    blockers, warnings = _pending_documents(fiscal_year)
    if fiscal_year.status not in (FiscalYearStatus.ACTIVE, FiscalYearStatus.CLOSING, FiscalYearStatus.REOPENED):
        blockers.append({"check": "Status", "message": f"The fiscal year is {fiscal_year.get_status_display().lower()}."})
    earlier_open = FiscalYear.objects.filter(organization=org, end_date__lt=fiscal_year.start_date).exclude(status=FiscalYearStatus.CLOSED)
    if earlier_open.exists():
        blockers.append({"check": "Earlier years", "message": "Close earlier fiscal years first: "
                         + ", ".join(fy.name for fy in earlier_open)})

    lines = posted_lines(org).filter(entry__date__lte=end)
    totals = lines.aggregate(d=Sum("debit"), c=Sum("credit"))
    ledger_balanced = (totals["d"] or ZERO) == (totals["c"] or ZERO)
    if not ledger_balanced:
        blockers.append({"check": "Trial balance", "message": f"Ledger does not balance: debit {totals['d']} credit {totals['c']}."})

    def control(key):
        agg = lines.filter(account__system_key=key).aggregate(d=Sum("debit"), c=Sum("credit"))
        return (agg["d"] or ZERO) - (agg["c"] or ZERO)

    inventory_gl = control(SystemAccount.INVENTORY)
    inventory_stock = StockLedgerEntry.objects.filter(organization=org, date__lte=end).aggregate(v=Sum("value"))["v"] or ZERO
    if inventory_gl != inventory_stock:
        blockers.append({"check": "Inventory valuation",
                         "message": f"Inventory account {inventory_gl} differs from stock valuation {inventory_stock}."})

    ar_gl = control(SystemAccount.RECEIVABLE)
    ar_parties = lines.filter(account__system_key=SystemAccount.RECEIVABLE, customer__isnull=False).aggregate(
        d=Sum("debit"), c=Sum("credit"))
    ar_sub = (ar_parties["d"] or ZERO) - (ar_parties["c"] or ZERO)
    if ar_gl != ar_sub:
        blockers.append({"check": "Receivables", "message": f"AR control {ar_gl} differs from customer ledgers {ar_sub}."})
    ap_gl = -control(SystemAccount.PAYABLE)
    ap_parties = lines.filter(account__system_key=SystemAccount.PAYABLE, supplier__isnull=False).aggregate(
        d=Sum("debit"), c=Sum("credit"))
    ap_sub = (ap_parties["c"] or ZERO) - (ap_parties["d"] or ZERO)
    if ap_gl != ap_sub:
        blockers.append({"check": "Payables", "message": f"AP control {ap_gl} differs from supplier ledgers {ap_sub}."})

    cash_bank = []
    for account in Account.objects.filter(organization=org, is_group=False).filter(is_cash=True) | Account.objects.filter(
        organization=org, is_group=False, is_bank=True
    ):
        agg = lines.filter(account=account).aggregate(d=Sum("debit"), c=Sum("credit"))
        balance = (agg["d"] or ZERO) - (agg["c"] or ZERO)
        cash_bank.append({"account": str(account), "balance": _s(balance)})
        if balance < 0:
            warnings.append({"check": "Cash and bank", "message": f"{account} has a negative balance ({balance})."})
    grni = -control(SystemAccount.GRNI)
    if grni != 0:
        warnings.append({"check": "Goods received not invoiced",
                         "message": f"{grni} of goods received has not been billed; it carries forward as a liability."})

    pl_rows = []
    year_lines = lines.filter(entry__date__gte=fiscal_year.start_date).exclude(entry__source=JournalSource.YEAR_END)
    income = expense = ZERO
    for row in (year_lines.filter(account__account_type__in=[AccountType.INCOME, AccountType.EXPENSE])
                .values("account", "account__code", "account__name", "account__account_type")
                .annotate(d=Sum("debit"), c=Sum("credit")).order_by("account__code")):
        net = (row["d"] or ZERO) - (row["c"] or ZERO)
        if net == 0:
            continue
        if row["account__account_type"] == AccountType.INCOME:
            income += -net
        else:
            expense += net
        pl_rows.append({"account_id": row["account"], "code": row["account__code"], "name": row["account__name"],
                        "type": row["account__account_type"], "balance": _s(net)})
    next_year = FiscalYear.objects.filter(organization=org, start_date__gt=end).order_by("start_date").first()
    if next_year is None:
        warnings.append({"check": "Next fiscal year", "message": "No following fiscal year is configured yet."})
    elif (next_year.start_date - end).days != 1:
        warnings.append({"check": "Next fiscal year", "message": f"{next_year.name} does not start the day after this year ends."})

    return {
        "fiscal_year": {"id": fiscal_year.pk, "name": fiscal_year.name, "start_date": fiscal_year.start_date.isoformat(),
                        "end_date": end.isoformat(), "start_date_bs": fiscal_year.start_date_bs, "end_date_bs": fiscal_year.end_date_bs},
        "can_close": not blockers,
        "blockers": blockers,
        "warnings": warnings,
        "totals": {
            "ledger_debit": _s(totals["d"]), "ledger_credit": _s(totals["c"]),
            "inventory_gl": _s(inventory_gl), "inventory_stock": _s(inventory_stock),
            "receivables": _s(ar_gl), "payables": _s(ap_gl), "grni": _s(grni),
            "income": _s(income), "expenses": _s(expense), "net_profit": _s(income - expense),
        },
        "cash_and_bank": cash_bank,
        "closing_entries": pl_rows,
        "next_fiscal_year": {"id": next_year.pk, "name": next_year.name} if next_year else None,
    }


@transaction.atomic
def close(fiscal_year, user, confirmation, request=None):
    fiscal_year = FiscalYear.objects.select_for_update().get(pk=fiscal_year.pk)
    if confirmation != fiscal_year.code:
        raise BusinessRuleError(f"Type the fiscal year code ({fiscal_year.code}) to confirm the close.", "confirmation")
    periods = list(AccountingPeriod.objects.select_for_update().filter(fiscal_year=fiscal_year).order_by("number"))
    summary = preview(fiscal_year)
    if not summary["can_close"]:
        raise BusinessRuleError("The fiscal year cannot be closed until the blockers are resolved.", "close_blocked",
                                errors={"blockers": [b["message"] for b in summary["blockers"]]})
    org = fiscal_year.organization
    retained = system_account(org, SystemAccount.RETAINED_EARNINGS)
    accounts = {a.pk: a for a in Account.objects.filter(pk__in=[r["account_id"] for r in summary["closing_entries"]])}
    lines = []
    for row in summary["closing_entries"]:
        net = Decimal(row["balance"])
        lines.append(Line(accounts[row["account_id"]], debit=-net if net < 0 else ZERO, credit=net if net > 0 else ZERO,
                          description="Year-end close"))
    net_profit = Decimal(summary["totals"]["net_profit"])
    lines.append(Line(retained, debit=-net_profit if net_profit < 0 else ZERO, credit=net_profit if net_profit > 0 else ZERO,
                      description="Net result for the year"))
    # Re-open the last period for the duration of this transaction if it was locked earlier.
    last = periods[-1]
    last_was_locked = last.status == PeriodStatus.LOCKED
    if last_was_locked:
        last.status = PeriodStatus.OPEN
        last.save(update_fields=["status"])
    closing_number = FiscalYearClosing.objects.filter(fiscal_year=fiscal_year).count() + 1
    journal = None
    if any(line.debit or line.credit for line in lines):
        journal = post_journal(
            org, date=fiscal_year.end_date, lines=lines, source=JournalSource.YEAR_END, source_id=fiscal_year.pk,
            source_number=fiscal_year.code, user=user, idempotency_key=f"YE:{fiscal_year.pk}:{closing_number}",
            narration=f"Year-end closing entries – {fiscal_year.name}",
        )
    now = timezone.now()
    for period in periods:
        if period.status != PeriodStatus.LOCKED or period.pk == last.pk:
            period.status = PeriodStatus.LOCKED
            period.locked_by = user
            period.locked_at = now
            period.lock_reason = period.lock_reason or "Year-end close"
            period.save()
    next_year = FiscalYear.objects.filter(pk=(summary["next_fiscal_year"] or {}).get("id")).first()
    if next_year:
        next_year.opening_balance_status = OpeningBalanceStatus.CARRIED_FORWARD
        next_year.save(update_fields=["opening_balance_status", "updated_at"])
    fiscal_year.status = FiscalYearStatus.CLOSED
    fiscal_year.closing_status = ClosingStatus.CLOSED
    fiscal_year.closed_by = user
    fiscal_year.closed_at = now
    fiscal_year.save()
    closing = FiscalYearClosing.objects.create(
        fiscal_year=fiscal_year, summary=summary, closing_journal=journal, retained_earnings_account=retained,
        next_fiscal_year=next_year, closed_by=user,
    )
    record_event(request or user, "fiscal_year.closed", "fiscal_year", fiscal_year, organization=org,
                 new={"net_profit": summary["totals"]["net_profit"], "closing_journal": journal.number if journal else None})
    return closing


@transaction.atomic
def reopen(fiscal_year, user, reason, request=None):
    """Reopen a closed year: reverse its closing journal; periods stay locked until reopened one by one."""
    if not reason or not reason.strip():
        raise BusinessRuleError("A reason is required to reopen a fiscal year.")
    fiscal_year = FiscalYear.objects.select_for_update().get(pk=fiscal_year.pk)
    if fiscal_year.status != FiscalYearStatus.CLOSED:
        raise BusinessRuleError("Only closed fiscal years can be reopened.")
    later_closed = FiscalYear.objects.filter(organization=fiscal_year.organization, start_date__gt=fiscal_year.end_date,
                                             status=FiscalYearStatus.CLOSED)
    if later_closed.exists():
        raise BusinessRuleError("Reopen later closed fiscal years first.")
    closing = fiscal_year.closings.filter(reopened_at__isnull=True).order_by("-id").first()
    if closing and closing.closing_journal_id:
        closing.reversal_journal = reverse_journal(
            closing.closing_journal, date=fiscal_year.end_date, user=user, reason=f"Fiscal year reopened: {reason}",
            allow_closed_fiscal_year=True,
        )
    if closing:
        closing.reopened_at = timezone.now()
        closing.save()
        if closing.next_fiscal_year_id:
            FiscalYear.objects.filter(pk=closing.next_fiscal_year_id).update(opening_balance_status=OpeningBalanceStatus.PENDING)
    fiscal_year.status = FiscalYearStatus.REOPENED
    fiscal_year.closing_status = ClosingStatus.OPEN
    fiscal_year.save()
    record_event(request or user, "fiscal_year.reopened", "fiscal_year", fiscal_year, reason=reason,
                 organization=fiscal_year.organization)
    return fiscal_year
