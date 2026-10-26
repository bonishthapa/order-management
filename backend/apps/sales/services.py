"""Sales workflow: order → approval/reservation → delivery → invoice → receipt → return.

Revenue is recognised when an invoice is posted; cost of goods sold when stock leaves the
warehouse (delivery, or posting of a direct invoice). Creating or approving an order changes
neither stock nor the ledger; approval only reserves available stock.
"""
from decimal import Decimal

from django.db import transaction
from django.db.models import F
from django.utils import timezone

from apps.accounting.models import JournalSource, SystemAccount
from apps.accounting.services import Line, party_balance, post_journal, reverse_journal, system_account
from apps.audit.services import record_event
from apps.core.exceptions import BusinessRuleError
from apps.core.money import ZERO, money, rate
from apps.core.numbering import next_number
from apps.fiscal_years.services import get_posting_period
from apps.inventory import services as stock
from apps.inventory.models import MovementType

from .models import (
    Delivery,
    DeliveryStatus,
    InspectionStatus,
    InvoiceStatus,
    PaymentStatus,
    ReturnStatus,
    SalesInvoice,
    SalesOrder,
    SalesOrderLine,
    SalesOrderStatus,
    SalesReturn,
)

OPEN_ORDER_STATUSES = (SalesOrderStatus.APPROVED, SalesOrderStatus.PARTIAL)


def _lock_order(order):
    return SalesOrder.objects.select_for_update().get(pk=order.pk)


def _event(request, user, action, obj, **kwargs):
    record_event(request or user, action, obj.__class__.__name__.lower(), obj, organization=obj.organization, **kwargs)


# --- Orders -----------------------------------------------------------------------------------


def credit_exposure(customer):
    """Receivable balance plus the un-invoiced value of approved orders."""
    balance = party_balance(customer.organization, customer=customer)
    open_value = ZERO
    for line in SalesOrderLine.objects.filter(order__customer=customer, order__status__in=OPEN_ORDER_STATUSES):
        if line.quantity:
            open_value += money(line.line_total * (line.quantity - line.invoiced_quantity) / line.quantity)
    return balance + open_value


@transaction.atomic
def submit_order(order, user, request=None):
    order = _lock_order(order)
    if order.status not in (SalesOrderStatus.DRAFT, SalesOrderStatus.REJECTED):
        raise BusinessRuleError("Only draft orders can be submitted.")
    if not order.lines.exists():
        raise BusinessRuleError("Add at least one line before submitting.")
    order.status = SalesOrderStatus.SUBMITTED
    order.submitted_at = timezone.now()
    order.submitted_by = user
    order.rejection_reason = ""
    order.save()
    _event(request, user, "sales_order.submitted", order)
    if not order.organization.require_sales_order_approval:
        return approve_order(order, user, request=request, auto=True)
    return order


@transaction.atomic
def approve_order(order, user, override_credit_limit=False, request=None, auto=False):
    order = _lock_order(order)
    if order.status != SalesOrderStatus.SUBMITTED:
        raise BusinessRuleError("Only orders awaiting approval can be approved.")
    customer = order.customer
    if not customer.is_active:
        raise BusinessRuleError(f"Customer {customer} is inactive.")
    if customer.credit_limit > 0:
        exposure = credit_exposure(customer) + order.grand_total
        if exposure > customer.credit_limit and not override_credit_limit:
            raise BusinessRuleError(
                f"Credit limit exceeded: exposure {exposure} > limit {customer.credit_limit}. "
                "Approve with a credit-limit override if this is intended.",
                "credit_limit",
            )
    order.status = SalesOrderStatus.APPROVED
    order.approved_at = timezone.now()
    order.approved_by = user
    order.save()
    reserved = reserve_order(order)
    _event(request, user, "sales_order.approved", order,
           new={"reserved": {str(k): str(v) for k, v in reserved.items()}, "credit_override": override_credit_limit, "auto": auto})
    return order


def reserve_order(order):
    """Reserve available stock for every line's unreserved, undelivered quantity."""
    reserved = {}
    for line in order.lines.select_related("product").order_by("product_id"):
        needed = line.quantity - line.delivered_quantity - line.reserved_quantity
        if needed > 0:
            reserved[line.pk] = stock.reserve(line, order.warehouse, needed)
    return reserved


@transaction.atomic
def rereserve_order(order, user, request=None):
    order = _lock_order(order)
    if order.status not in OPEN_ORDER_STATUSES:
        raise BusinessRuleError("Stock can only be reserved for approved, open orders.")
    reserved = reserve_order(order)
    _event(request, user, "sales_order.reserved", order, new={str(k): str(v) for k, v in reserved.items()})
    return order


@transaction.atomic
def reject_order(order, user, reason, request=None):
    order = _lock_order(order)
    if order.status != SalesOrderStatus.SUBMITTED:
        raise BusinessRuleError("Only orders awaiting approval can be rejected.")
    if not reason:
        raise BusinessRuleError("A rejection reason is required.")
    order.status = SalesOrderStatus.REJECTED
    order.rejection_reason = reason
    order.save()
    _event(request, user, "sales_order.rejected", order, reason=reason)
    return order


@transaction.atomic
def cancel_order(order, user, reason, request=None):
    order = _lock_order(order)
    if order.status in (SalesOrderStatus.CANCELLED, SalesOrderStatus.COMPLETED):
        raise BusinessRuleError("This order is already closed.")
    if order.deliveries.filter(status=DeliveryStatus.POSTED).exists() or order.invoices.filter(status=InvoiceStatus.POSTED).exists():
        raise BusinessRuleError("Orders with posted deliveries or invoices cannot be cancelled; close the remaining balance instead.")
    if not reason:
        raise BusinessRuleError("A cancellation reason is required.")
    for line in order.lines.all():
        stock.release(line, order.warehouse)
    order.deliveries.filter(status=DeliveryStatus.DRAFT).update(status=DeliveryStatus.CANCELLED)
    order.status = SalesOrderStatus.CANCELLED
    order.cancelled_at = timezone.now()
    order.cancellation_reason = reason
    order.save()
    _event(request, user, "sales_order.cancelled", order, reason=reason)
    return order


@transaction.atomic
def close_order(order, user, reason, request=None):
    """Close a partially delivered order: release reservations and cancel the backorder."""
    order = _lock_order(order)
    if order.status not in OPEN_ORDER_STATUSES:
        raise BusinessRuleError("Only approved or partially delivered orders can be closed.")
    for line in order.lines.all():
        stock.release(line, order.warehouse)
    order.status = SalesOrderStatus.COMPLETED
    order.cancellation_reason = reason
    order.save()
    _event(request, user, "sales_order.closed", order, reason=reason)
    return order


def _refresh_order_status(order):
    lines = list(order.lines.all())
    if order.status not in OPEN_ORDER_STATUSES:
        return
    if all(line.delivered_quantity >= line.quantity for line in lines):
        order.status = SalesOrderStatus.COMPLETED
    elif any(line.delivered_quantity > 0 for line in lines):
        order.status = SalesOrderStatus.PARTIAL
    else:
        order.status = SalesOrderStatus.APPROVED
    order.save(update_fields=["status", "updated_at"])


# --- Deliveries -------------------------------------------------------------------------------


@transaction.atomic
def post_delivery(delivery, user, request=None):
    delivery = Delivery.objects.select_for_update().get(pk=delivery.pk)
    if delivery.status != DeliveryStatus.DRAFT:
        raise BusinessRuleError("This delivery has already been posted.", "duplicate_posting")
    order = _lock_order(delivery.sales_order)
    if order.status not in OPEN_ORDER_STATUSES:
        raise BusinessRuleError(f"Order {order.number} is {order.get_status_display().lower()}; it cannot be delivered.")
    organization = delivery.organization
    lines = list(delivery.lines.select_related("product", "product__unit", "order_line"))
    if not lines:
        raise BusinessRuleError("Add at least one line to the delivery.")
    order_lines = {l.pk: l for l in SalesOrderLine.objects.select_for_update().filter(order=order)}
    stock_lines = []
    for line in lines:
        order_line = order_lines.get(line.order_line_id)
        if order_line is None:
            raise BusinessRuleError("A delivery line does not belong to this order.")
        remaining = order_line.quantity - order_line.delivered_quantity
        if line.quantity > remaining:
            raise BusinessRuleError(
                f"{line.product.sku}: delivering {line.quantity} exceeds the undelivered quantity {remaining}.",
                "over_fulfilment",
            )
        if line.product.is_stock:
            stock.release(order_line, delivery.warehouse, line.quantity, consumed=True)
            stock_lines.append(stock.StockLine(product=line.product, quantity=-line.quantity, batch_number=line.batch_number,
                                               serial_numbers=line.serial_numbers or []))
    delivery.number = next_number(organization, "DN", delivery.date, stock.warehouse_branch_code(delivery.warehouse))
    total_cost = ZERO
    if stock_lines:
        movement, posted = stock.post_stock(
            organization, movement_type=MovementType.ISSUE, date=delivery.date, warehouse=delivery.warehouse,
            lines=stock_lines, user=user, reference_type="delivery", reference_id=delivery.pk,
            reference_number=delivery.number, reason=f"Delivery for {order.number}",
        )
        delivery.stock_movement = movement
        costs = {}
        for p in posted:
            costs.setdefault(p.entry.product_id, []).append(p)
        for line in lines:
            if line.product.is_stock:
                p = costs[line.product_id].pop(0)
                line.cost_amount = p.cost
                line.unit_cost = rate(p.cost / line.quantity)
                line.save(update_fields=["cost_amount", "unit_cost"])
                total_cost += p.cost
    else:
        get_posting_period(organization, delivery.date)
    for line in lines:
        order_line = order_lines[line.order_line_id]
        SalesOrderLine.objects.filter(pk=order_line.pk).update(delivered_quantity=F("delivered_quantity") + line.quantity)
    if total_cost > 0:
        delivery.journal = post_journal(
            organization, date=delivery.date, source=JournalSource.DELIVERY, source_id=delivery.pk,
            source_number=delivery.number, narration=f"Cost of goods delivered – {delivery.number} ({order.number})",
            user=user, idempotency_key=f"DN:{delivery.pk}",
            lines=[Line(system_account(organization, SystemAccount.COGS), debit=total_cost),
                   Line(system_account(organization, SystemAccount.INVENTORY), credit=total_cost)],
        )
    delivery.status = DeliveryStatus.POSTED
    delivery.posted_at = timezone.now()
    delivery.posted_by = user
    delivery.save()
    order.refresh_from_db()
    _refresh_order_status(order)
    _event(request, user, "delivery.posted", delivery, new={"order": order.number, "cost": str(total_cost)})
    return delivery


@transaction.atomic
def reverse_delivery(delivery, user, reason, request=None):
    delivery = Delivery.objects.select_for_update().get(pk=delivery.pk)
    if delivery.status != DeliveryStatus.POSTED:
        raise BusinessRuleError("Only posted deliveries can be reversed.")
    if not reason:
        raise BusinessRuleError("A reason is required.")
    order = _lock_order(delivery.sales_order)
    order_lines = {l.pk: l for l in SalesOrderLine.objects.select_for_update().filter(order=order)}
    lines = list(delivery.lines.select_related("product", "product__unit"))
    for line in lines:
        ol = order_lines[line.order_line_id]
        if ol.delivered_quantity - line.quantity < ol.invoiced_quantity and not order.organization.allow_invoice_before_delivery:
            raise BusinessRuleError(f"{line.product.sku} has been invoiced; reverse or return the invoice first.")
    date = max(timezone.localdate(), delivery.date)
    if delivery.stock_movement_id:
        stock.reverse_stock(delivery.stock_movement, date=date, user=user, reason=reason, reference_type="delivery",
                            reference_id=delivery.pk, reference_number=delivery.number)
    if delivery.journal_id:
        reverse_journal(delivery.journal, date=date, user=user, reason=reason)
    for line in lines:
        SalesOrderLine.objects.filter(pk=line.order_line_id).update(delivered_quantity=F("delivered_quantity") - line.quantity)
    delivery.status = DeliveryStatus.REVERSED
    delivery.save(update_fields=["status", "updated_at"])
    order.refresh_from_db()
    if order.status == SalesOrderStatus.COMPLETED:
        order.status = SalesOrderStatus.PARTIAL
        order.save(update_fields=["status"])
    _refresh_order_status(order)
    _event(request, user, "delivery.reversed", delivery, reason=reason)
    return delivery


# --- Invoices ---------------------------------------------------------------------------------


def refresh_invoice_balance(invoice):
    """Recompute paid/credited/balance from active allocations. Caller holds the invoice lock."""
    from django.db.models import Sum

    from apps.payments.models import InvoiceAllocation

    active = InvoiceAllocation.objects.filter(invoice=invoice, is_active=True)
    paid = active.filter(receipt__isnull=False).aggregate(s=Sum("amount"))["s"] or ZERO
    credited = active.filter(credit_note__isnull=False).aggregate(s=Sum("amount"))["s"] or ZERO
    invoice.amount_paid = paid
    invoice.amount_credited = credited
    invoice.balance_due = invoice.grand_total - paid - credited
    if invoice.balance_due < 0:
        raise BusinessRuleError(f"Allocations exceed the total of invoice {invoice.number}.", "over_allocation")
    if invoice.balance_due == 0:
        invoice.payment_status = PaymentStatus.PAID
    elif paid + credited > 0:
        invoice.payment_status = PaymentStatus.PARTIAL
    else:
        invoice.payment_status = PaymentStatus.UNPAID
    invoice.save(update_fields=["amount_paid", "amount_credited", "balance_due", "payment_status", "updated_at"])
    return invoice


def _order_line_unit_cost(order_line):
    total_qty = ZERO
    total_cost = ZERO
    for dl in order_line.delivery_lines.filter(delivery__status=DeliveryStatus.POSTED):
        total_qty += dl.quantity
        total_cost += dl.cost_amount
    return rate(total_cost / total_qty) if total_qty else ZERO


@transaction.atomic
def post_invoice(invoice, user, request=None):
    invoice = SalesInvoice.objects.select_for_update().get(pk=invoice.pk)
    if invoice.status != InvoiceStatus.DRAFT:
        raise BusinessRuleError("This invoice has already been posted.", "duplicate_posting")
    organization = invoice.organization
    customer = invoice.customer
    if not customer.is_active:
        raise BusinessRuleError(f"Customer {customer} is inactive.")
    lines = invoice.recalculate(list(invoice.lines.select_related("product", "product__unit", "tax_rate", "order_line")))
    if not lines:
        raise BusinessRuleError("Add at least one line to the invoice.")
    period = get_posting_period(organization, invoice.invoice_date)

    direct_stock = []
    if invoice.sales_order_id:
        order = _lock_order(invoice.sales_order)
        if order.status in (SalesOrderStatus.DRAFT, SalesOrderStatus.SUBMITTED, SalesOrderStatus.REJECTED, SalesOrderStatus.CANCELLED):
            raise BusinessRuleError(f"Order {order.number} is not approved.")
        order_lines = {l.pk: l for l in SalesOrderLine.objects.select_for_update().filter(order=order)}
        for line in lines:
            ol = order_lines.get(line.order_line_id)
            if ol is None:
                raise BusinessRuleError(f"{line.product.sku}: every line must reference a line of order {order.number}.")
            limit = ol.quantity if organization.allow_invoice_before_delivery else ol.delivered_quantity
            if ol.invoiced_quantity + line.quantity > limit:
                raise BusinessRuleError(
                    f"{line.product.sku}: invoicing {line.quantity} exceeds the {'ordered' if organization.allow_invoice_before_delivery else 'delivered'} "
                    f"but uninvoiced quantity {limit - ol.invoiced_quantity}.",
                    "over_invoicing",
                )
        for line in lines:
            SalesOrderLine.objects.filter(pk=line.order_line_id).update(invoiced_quantity=F("invoiced_quantity") + line.quantity)
    else:
        for line in lines:
            if line.order_line_id:
                raise BusinessRuleError("Order lines can only be invoiced on an invoice linked to that order.")
            if line.product.is_stock:
                if invoice.warehouse_id is None:
                    raise BusinessRuleError("Select the warehouse that stock items are issued from.")
                direct_stock.append(line)

    invoice.number = next_number(organization, "SI", invoice.invoice_date,
                                 stock.warehouse_branch_code(invoice.warehouse) if invoice.warehouse_id else "")
    invoice.fiscal_year = period.fiscal_year
    invoice.customer_name = invoice.customer_name or customer.name
    invoice.customer_address = invoice.customer_address or customer.billing_address
    invoice.customer_tax_id = invoice.customer_tax_id or customer.tax_id

    charges = money(invoice.freight) + money(invoice.other_charges)
    journal_lines = [
        Line(system_account(organization, SystemAccount.RECEIVABLE), debit=invoice.grand_total, customer=customer,
             description=f"Invoice {invoice.number}"),
        Line(system_account(organization, SystemAccount.SALES), credit=invoice.taxable_total),
        Line(system_account(organization, SystemAccount.TAX_PAYABLE), credit=invoice.tax_total),
        Line(system_account(organization, SystemAccount.OTHER_INCOME), credit=charges),
    ]
    invoice.journal = post_journal(
        organization, date=invoice.invoice_date, lines=journal_lines, source=JournalSource.SALES_INVOICE,
        source_id=invoice.pk, source_number=invoice.number, user=user, idempotency_key=f"SI:{invoice.pk}",
        narration=f"Sales invoice {invoice.number} – {customer.name}",
    )

    if direct_stock:
        movement, posted = stock.post_stock(
            organization, movement_type=MovementType.ISSUE, date=invoice.invoice_date, warehouse=invoice.warehouse,
            lines=[stock.StockLine(product=l.product, quantity=-l.quantity, batch_number=l.batch_number,
                                   serial_numbers=l.serial_numbers or []) for l in direct_stock],
            user=user, reference_type="sales_invoice", reference_id=invoice.pk, reference_number=invoice.number,
            reason=f"Direct invoice {invoice.number}",
        )
        invoice.stock_movement = movement
        by_product = {}
        for p in posted:
            by_product.setdefault(p.entry.product_id, []).append(p)
        total_cost = ZERO
        for line in direct_stock:
            p = by_product[line.product_id].pop(0)
            line.unit_cost = rate(p.cost / line.quantity)
            total_cost += p.cost
        if total_cost > 0:
            invoice.cogs_journal = post_journal(
                organization, date=invoice.invoice_date, source=JournalSource.DELIVERY, source_id=invoice.pk,
                source_number=invoice.number, user=user, idempotency_key=f"SI-COGS:{invoice.pk}",
                narration=f"Cost of goods sold – direct invoice {invoice.number}",
                lines=[Line(system_account(organization, SystemAccount.COGS), debit=total_cost),
                       Line(system_account(organization, SystemAccount.INVENTORY), credit=total_cost)],
            )
    for line in lines:
        line.save()
    invoice.status = InvoiceStatus.POSTED
    invoice.posted_at = timezone.now()
    invoice.posted_by = user
    invoice.balance_due = invoice.grand_total
    invoice.save()
    refresh_invoice_balance(invoice)
    _event(request, user, "sales_invoice.posted", invoice, new={"grand_total": str(invoice.grand_total)})
    return invoice


@transaction.atomic
def reverse_invoice(invoice, user, reason, request=None):
    invoice = SalesInvoice.objects.select_for_update().get(pk=invoice.pk)
    if invoice.status != InvoiceStatus.POSTED:
        raise BusinessRuleError("Only posted invoices can be reversed.")
    if not reason:
        raise BusinessRuleError("A reason is required.")
    if invoice.allocations.filter(is_active=True).exists():
        raise BusinessRuleError("Reverse or reallocate the receipts and credit notes applied to this invoice first.")
    if invoice.returns.filter(status=ReturnStatus.POSTED).exists():
        raise BusinessRuleError("This invoice has posted returns and cannot be reversed.")
    date = max(timezone.localdate(), invoice.invoice_date)
    reverse_journal(invoice.journal, date=date, user=user, reason=reason)
    if invoice.cogs_journal_id:
        reverse_journal(invoice.cogs_journal, date=date, user=user, reason=reason)
    if invoice.stock_movement_id:
        stock.reverse_stock(invoice.stock_movement, date=date, user=user, reason=reason, reference_type="sales_invoice",
                            reference_id=invoice.pk, reference_number=invoice.number)
    for line in invoice.lines.filter(order_line__isnull=False):
        SalesOrderLine.objects.filter(pk=line.order_line_id).update(invoiced_quantity=F("invoiced_quantity") - line.quantity)
    invoice.status = InvoiceStatus.REVERSED
    invoice.reversal_reason = reason
    invoice.balance_due = ZERO
    invoice.save(update_fields=["status", "reversal_reason", "balance_due", "updated_at"])
    _event(request, user, "sales_invoice.reversed", invoice, reason=reason)
    return invoice


# --- Returns / credit notes -------------------------------------------------------------------


@transaction.atomic
def post_sales_return(sales_return, user, request=None):
    from apps.payments.services import allocate_credit_note

    sales_return = SalesReturn.objects.select_for_update().get(pk=sales_return.pk)
    if sales_return.status != ReturnStatus.DRAFT:
        raise BusinessRuleError("This return has already been posted.", "duplicate_posting")
    invoice = SalesInvoice.objects.select_for_update().get(pk=sales_return.invoice_id)
    if invoice.status != InvoiceStatus.POSTED:
        raise BusinessRuleError("Returns can only be raised against posted invoices.")
    if sales_return.date < invoice.invoice_date:
        raise BusinessRuleError("The return date cannot be before the invoice date.")
    organization = sales_return.organization
    customer = invoice.customer
    lines = sales_return.recalculate(list(sales_return.lines.select_related("product", "product__unit", "tax_rate", "invoice_line")))
    if not lines:
        raise BusinessRuleError("Add at least one line to the return.")
    period = get_posting_period(organization, sales_return.date)
    from .models import SalesInvoiceLine

    restock = []
    for line in lines:
        il = SalesInvoiceLine.objects.select_for_update().get(pk=line.invoice_line_id)
        if il.invoice_id != invoice.pk:
            raise BusinessRuleError("A return line does not belong to the original invoice.")
        if line.quantity > il.quantity - il.returned_quantity:
            raise BusinessRuleError(
                f"{line.product.sku}: returning {line.quantity} exceeds the returnable quantity {il.quantity - il.returned_quantity}.",
                "over_return",
            )
        if line.inspection == InspectionStatus.PENDING:
            raise BusinessRuleError(f"{line.product.sku}: complete the inspection (restock or damaged) before posting.")
        il.returned_quantity += line.quantity
        il.save(update_fields=["returned_quantity"])
        if line.product.is_stock:
            # Restock at the cost that left inventory: the delivery cost for order-linked lines,
            # the direct-issue cost otherwise.
            line.unit_cost = _order_line_unit_cost(il.order_line) if il.order_line_id else il.unit_cost
            line.save(update_fields=["unit_cost"])
            if line.inspection == InspectionStatus.RESTOCK:
                restock.append(line)

    sales_return.number = next_number(organization, "SR", sales_return.date, stock.warehouse_branch_code(sales_return.warehouse))
    sales_return.fiscal_year = period.fiscal_year
    journal_lines = [
        Line(system_account(organization, SystemAccount.SALES_RETURNS), debit=sales_return.taxable_total),
        Line(system_account(organization, SystemAccount.TAX_PAYABLE), debit=sales_return.tax_total),
        Line(system_account(organization, SystemAccount.RECEIVABLE), credit=sales_return.grand_total, customer=customer,
             description=f"Credit note {sales_return.number}"),
    ]
    if restock:
        movement, posted = stock.post_stock(
            organization, movement_type=MovementType.SALES_RETURN, date=sales_return.date, warehouse=sales_return.warehouse,
            lines=[stock.StockLine(product=l.product, quantity=l.quantity, unit_cost=l.unit_cost, batch_number=l.batch_number,
                                   serial_numbers=l.serial_numbers or []) for l in restock],
            user=user, reference_type="sales_return", reference_id=sales_return.pk, reference_number=sales_return.number,
            reason=f"Return against {invoice.number}",
        )
        sales_return.stock_movement = movement
        restocked_cost = sum((p.cost for p in posted), ZERO)
        journal_lines += [
            Line(system_account(organization, SystemAccount.INVENTORY), debit=restocked_cost),
            Line(system_account(organization, SystemAccount.COGS), credit=restocked_cost),
        ]
    for line in lines:
        line.save()
    sales_return.journal = post_journal(
        organization, date=sales_return.date, lines=journal_lines, source=JournalSource.SALES_RETURN,
        source_id=sales_return.pk, source_number=sales_return.number, user=user, idempotency_key=f"SR:{sales_return.pk}",
        narration=f"Sales return / credit note {sales_return.number} against {invoice.number}",
    )
    sales_return.status = ReturnStatus.POSTED
    sales_return.posted_at = timezone.now()
    sales_return.posted_by = user
    sales_return.save()
    apply_amount = min(invoice.balance_due, sales_return.grand_total)
    if apply_amount > 0:
        allocate_credit_note(sales_return, [(invoice, apply_amount)], user, lock=False)
    _event(request, user, "sales_return.posted", sales_return, new={"invoice": invoice.number, "credit": str(sales_return.grand_total)})
    return sales_return


def invoiceable_lines(order):
    """Order lines with quantity that can still be invoiced under the organisation's policy."""
    allow_before = order.organization.allow_invoice_before_delivery
    result = []
    for line in order.lines.select_related("product", "tax_rate"):
        limit = line.quantity if allow_before else line.delivered_quantity
        open_qty = limit - line.invoiced_quantity
        if open_qty > 0:
            result.append((line, open_qty))
    return result


def price_for(product, customer, quantity: Decimal):
    """Best applicable unit price: highest tier whose minimum quantity is met (customer category tiers first)."""
    tiers = product.price_tiers.filter(min_quantity__lte=quantity).order_by("-min_quantity")
    category_id = customer.category_id if customer else None
    for tier in tiers:
        if tier.customer_category_id and tier.customer_category_id == category_id:
            return tier.price
    for tier in tiers:
        if tier.customer_category_id is None:
            return tier.price
    return product.selling_price
