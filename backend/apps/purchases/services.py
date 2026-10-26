"""Purchase workflow: order → approval → goods receipt (GRN) → supplier bill → payment → return.

Ledger effect (perpetual inventory with a GRNI clearing account):
* GRN posted:      Dr Inventory                       Cr Goods received not invoiced (GRNI)
* Bill posted:     Dr GRNI (GRN value of billed qty)  Dr Purchase price variance (bill − GRN value)
                   Dr Inventory (direct stock lines)  Dr Service purchases (non-stock lines)
                   Dr VAT receivable                  Dr Freight inward (charges)
                   Cr AP (supplier, grand total)
* Purchase return: Dr AP (supplier)   Cr Inventory (FIFO cost)   Cr VAT receivable   ± Purchase price variance
Only posting a GRN (or a direct bill) changes stock.
"""
from django.db import transaction
from django.db.models import F
from django.utils import timezone

from apps.accounting.models import JournalSource, SystemAccount
from apps.accounting.services import Line, post_journal, reverse_journal, system_account
from apps.audit.services import record_event
from apps.core.exceptions import BusinessRuleError
from apps.core.money import ZERO, money, rate
from apps.core.numbering import next_number
from apps.fiscal_years.services import get_posting_period
from apps.inventory import services as stock
from apps.inventory.models import MovementType

from .models import (
    BillStatus,
    GoodsReceipt,
    GoodsReceiptLine,
    GRNStatus,
    PurchaseOrder,
    PurchaseOrderLine,
    PurchaseOrderStatus,
    PurchaseReturn,
    SupplierBill,
    SupplierBillLine,
)

OPEN_PO_STATUSES = (PurchaseOrderStatus.APPROVED, PurchaseOrderStatus.PARTIAL)


def _event(request, user, action, obj, **kwargs):
    record_event(request or user, action, obj.__class__.__name__.lower(), obj, organization=obj.organization, **kwargs)


def _lock_po(order):
    return PurchaseOrder.objects.select_for_update().get(pk=order.pk)


@transaction.atomic
def submit_po(order, user, request=None):
    order = _lock_po(order)
    if order.status not in (PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.REJECTED):
        raise BusinessRuleError("Only draft purchase orders can be submitted.")
    if not order.lines.exists():
        raise BusinessRuleError("Add at least one line before submitting.")
    order.status = PurchaseOrderStatus.SUBMITTED
    order.submitted_at = timezone.now()
    order.submitted_by = user
    order.rejection_reason = ""
    order.save()
    _event(request, user, "purchase_order.submitted", order)
    if not order.organization.require_purchase_order_approval:
        return approve_po(order, user, request=request)
    return order


@transaction.atomic
def approve_po(order, user, request=None):
    order = _lock_po(order)
    if order.status != PurchaseOrderStatus.SUBMITTED:
        raise BusinessRuleError("Only purchase orders awaiting approval can be approved.")
    if not order.supplier.is_active:
        raise BusinessRuleError(f"Supplier {order.supplier} is inactive.")
    order.status = PurchaseOrderStatus.APPROVED
    order.approved_at = timezone.now()
    order.approved_by = user
    order.save()
    _event(request, user, "purchase_order.approved", order)
    return order


@transaction.atomic
def reject_po(order, user, reason, request=None):
    order = _lock_po(order)
    if order.status != PurchaseOrderStatus.SUBMITTED:
        raise BusinessRuleError("Only purchase orders awaiting approval can be rejected.")
    if not reason:
        raise BusinessRuleError("A rejection reason is required.")
    order.status = PurchaseOrderStatus.REJECTED
    order.rejection_reason = reason
    order.save()
    _event(request, user, "purchase_order.rejected", order, reason=reason)
    return order


@transaction.atomic
def cancel_po(order, user, reason, request=None):
    order = _lock_po(order)
    if order.status in (PurchaseOrderStatus.CANCELLED, PurchaseOrderStatus.COMPLETED):
        raise BusinessRuleError("This purchase order is already closed.")
    if order.receipts.filter(status=GRNStatus.POSTED).exists() or order.bills.filter(status=BillStatus.POSTED).exists():
        raise BusinessRuleError("Orders with posted receipts or bills cannot be cancelled; close the remaining balance instead.")
    if not reason:
        raise BusinessRuleError("A cancellation reason is required.")
    order.receipts.filter(status=GRNStatus.DRAFT).update(status=GRNStatus.CANCELLED)
    order.status = PurchaseOrderStatus.CANCELLED
    order.cancelled_at = timezone.now()
    order.cancellation_reason = reason
    order.save()
    _event(request, user, "purchase_order.cancelled", order, reason=reason)
    return order


@transaction.atomic
def close_po(order, user, reason, request=None):
    order = _lock_po(order)
    if order.status not in OPEN_PO_STATUSES:
        raise BusinessRuleError("Only approved or partially received orders can be closed.")
    order.status = PurchaseOrderStatus.COMPLETED
    order.cancellation_reason = reason
    order.save()
    _event(request, user, "purchase_order.closed", order, reason=reason)
    return order


def _refresh_po_status(order):
    if order.status not in OPEN_PO_STATUSES:
        return
    lines = list(order.lines.select_related("product"))
    stock_lines = [l for l in lines if l.product.is_stock]
    if stock_lines:
        fulfilled = all(l.received_quantity >= l.quantity for l in stock_lines)
    else:
        fulfilled = all(l.billed_quantity >= l.quantity for l in lines)
    if fulfilled:
        order.status = PurchaseOrderStatus.COMPLETED
    elif any(l.received_quantity > 0 or l.billed_quantity > 0 for l in lines):
        order.status = PurchaseOrderStatus.PARTIAL
    else:
        order.status = PurchaseOrderStatus.APPROVED
    order.save(update_fields=["status", "updated_at"])


# --- Goods receipts ---------------------------------------------------------------------------


@transaction.atomic
def post_grn(grn, user, request=None):
    grn = GoodsReceipt.objects.select_for_update().get(pk=grn.pk)
    if grn.status != GRNStatus.DRAFT:
        raise BusinessRuleError("This goods receipt has already been posted.", "duplicate_posting")
    order = _lock_po(grn.purchase_order)
    if order.status not in OPEN_PO_STATUSES:
        raise BusinessRuleError(f"Purchase order {order.number} is {order.get_status_display().lower()}; goods cannot be received.")
    organization = grn.organization
    lines = list(grn.lines.select_related("product", "product__unit"))
    if not lines:
        raise BusinessRuleError("Add at least one line to the goods receipt.")
    period = get_posting_period(organization, grn.date)
    order_lines = {l.pk: l for l in PurchaseOrderLine.objects.select_for_update().filter(order=order)}
    stock_lines = []
    for line in lines:
        ol = order_lines.get(line.order_line_id)
        if ol is None:
            raise BusinessRuleError("A receipt line does not belong to this purchase order.")
        if not line.product.is_stock:
            raise BusinessRuleError(f"{line.product.sku} is a non-stock item; bill it directly.")
        if line.accepted_quantity + line.rejected_quantity != line.received_quantity:
            raise BusinessRuleError(f"{line.product.sku}: accepted + rejected must equal the received quantity.")
        if line.rejected_quantity > 0 and not line.rejection_reason:
            raise BusinessRuleError(f"{line.product.sku}: give a reason for the rejected quantity.")
        pending = ol.quantity - ol.received_quantity
        if line.accepted_quantity > pending:
            raise BusinessRuleError(
                f"{line.product.sku}: accepting {line.accepted_quantity} exceeds the pending quantity {pending}.", "over_receipt"
            )
        line.unit_cost = rate(ol.net_unit_price)
        line.save(update_fields=["unit_cost"])
        if line.accepted_quantity > 0:
            stock_lines.append(stock.StockLine(
                product=line.product, quantity=line.accepted_quantity, unit_cost=line.unit_cost,
                batch_number=line.batch_number, expiry_date=line.expiry_date, manufacture_date=line.manufacture_date,
                serial_numbers=line.serial_numbers or [],
            ))
    grn.number = next_number(organization, "GRN", grn.date, stock.warehouse_branch_code(grn.warehouse))
    grn.fiscal_year = period.fiscal_year
    value = ZERO
    if stock_lines:
        movement, posted = stock.post_stock(
            organization, movement_type=MovementType.RECEIPT, date=grn.date, warehouse=grn.warehouse, lines=stock_lines,
            user=user, reference_type="goods_receipt", reference_id=grn.pk, reference_number=grn.number,
            reason=f"Receipt against {order.number}",
        )
        grn.stock_movement = movement
        value = sum((p.cost for p in posted), ZERO)
        grn.journal = post_journal(
            organization, date=grn.date, source=JournalSource.GOODS_RECEIPT, source_id=grn.pk, source_number=grn.number,
            user=user, idempotency_key=f"GRN:{grn.pk}", narration=f"Goods received {grn.number} ({order.number}) – {grn.supplier.name}",
            lines=[Line(system_account(organization, SystemAccount.INVENTORY), debit=value),
                   Line(system_account(organization, SystemAccount.GRNI), credit=value)],
        )
    for line in lines:
        PurchaseOrderLine.objects.filter(pk=line.order_line_id).update(
            received_quantity=F("received_quantity") + line.accepted_quantity,
            rejected_quantity=F("rejected_quantity") + line.rejected_quantity,
        )
    grn.total_value = value
    grn.status = GRNStatus.POSTED
    grn.posted_at = timezone.now()
    grn.received_by = grn.received_by or user
    grn.save()
    order.refresh_from_db()
    _refresh_po_status(order)
    _event(request, user, "goods_receipt.posted", grn, new={"order": order.number, "value": str(value)})
    return grn


@transaction.atomic
def reverse_grn(grn, user, reason, request=None):
    grn = GoodsReceipt.objects.select_for_update().get(pk=grn.pk)
    if grn.status != GRNStatus.POSTED:
        raise BusinessRuleError("Only posted goods receipts can be reversed.")
    if not reason:
        raise BusinessRuleError("A reason is required.")
    lines = list(GoodsReceiptLine.objects.select_for_update().filter(receipt=grn).select_related("product", "product__unit"))
    if any(l.billed_quantity > 0 for l in lines):
        raise BusinessRuleError("This receipt has been billed; reverse the bill or raise a purchase return instead.")
    date = max(timezone.localdate(), grn.date)
    order = _lock_po(grn.purchase_order)
    if grn.stock_movement_id:
        stock.reverse_stock(grn.stock_movement, date=date, user=user, reason=reason, reference_type="goods_receipt",
                            reference_id=grn.pk, reference_number=grn.number)
    if grn.journal_id:
        reverse_journal(grn.journal, date=date, user=user, reason=reason)
    for line in lines:
        PurchaseOrderLine.objects.filter(pk=line.order_line_id).update(
            received_quantity=F("received_quantity") - line.accepted_quantity,
            rejected_quantity=F("rejected_quantity") - line.rejected_quantity,
        )
    grn.status = GRNStatus.REVERSED
    grn.save(update_fields=["status", "updated_at"])
    order.refresh_from_db()
    if order.status == PurchaseOrderStatus.COMPLETED:
        order.status = PurchaseOrderStatus.PARTIAL
        order.save(update_fields=["status"])
    _refresh_po_status(order)
    _event(request, user, "goods_receipt.reversed", grn, reason=reason)
    return grn


# --- Supplier bills ---------------------------------------------------------------------------


def check_duplicate_supplier_invoice(bill):
    clash = SupplierBill.objects.filter(
        organization=bill.organization, supplier=bill.supplier,
        supplier_invoice_number__iexact=bill.supplier_invoice_number.strip(), status__in=[BillStatus.DRAFT, BillStatus.POSTED],
    ).exclude(pk=bill.pk).first()
    if clash:
        raise BusinessRuleError(
            f"Supplier invoice {bill.supplier_invoice_number} is already recorded on {clash}.", "duplicate_supplier_invoice"
        )


@transaction.atomic
def post_bill(bill, user, request=None):
    from apps.payments.services import refresh_bill_balance

    bill = SupplierBill.objects.select_for_update().get(pk=bill.pk)
    if bill.status != BillStatus.DRAFT:
        raise BusinessRuleError("This bill has already been posted.", "duplicate_posting")
    organization = bill.organization
    supplier = bill.supplier
    check_duplicate_supplier_invoice(bill)
    lines = bill.recalculate(list(bill.lines.select_related("product", "product__unit", "tax_rate", "order_line", "receipt_line")))
    if not lines:
        raise BusinessRuleError("Add at least one line to the bill.")
    period = get_posting_period(organization, bill.bill_date)

    grni_value = ZERO
    variance = ZERO
    service_value = ZERO
    direct_stock = []
    order = _lock_po(bill.purchase_order) if bill.purchase_order_id else None
    for line in lines:
        if line.receipt_line_id:
            rl = GoodsReceiptLine.objects.select_for_update().select_related("receipt").get(pk=line.receipt_line_id)
            if rl.receipt.status != GRNStatus.POSTED or rl.receipt.supplier_id != supplier.pk:
                raise BusinessRuleError("A bill line refers to a goods receipt that is not posted for this supplier.")
            if order and rl.receipt.purchase_order_id != order.pk:
                raise BusinessRuleError("A bill line refers to a goods receipt of another purchase order.")
            if line.quantity > rl.accepted_quantity - rl.billed_quantity:
                raise BusinessRuleError(
                    f"{line.product.sku}: billing {line.quantity} exceeds the received but unbilled quantity "
                    f"{rl.accepted_quantity - rl.billed_quantity}.", "over_billing",
                )
            received_value = money(line.quantity * rl.unit_cost)
            grni_value += received_value
            variance += line.taxable_amount - received_value
            GoodsReceiptLine.objects.filter(pk=rl.pk).update(billed_quantity=F("billed_quantity") + line.quantity)
            PurchaseOrderLine.objects.filter(pk=rl.order_line_id).update(billed_quantity=F("billed_quantity") + line.quantity)
            line.order_line_id = rl.order_line_id
        elif line.product.is_stock:
            if line.order_line_id:
                raise BusinessRuleError(f"{line.product.sku}: stock items on a purchase order are billed from their goods receipt.")
            if bill.warehouse_id is None:
                raise BusinessRuleError("Select the warehouse that receives the stock on this direct bill.")
            direct_stock.append(line)
        else:
            if line.order_line_id:
                ol = PurchaseOrderLine.objects.select_for_update().get(pk=line.order_line_id)
                if order is None or ol.order_id != order.pk:
                    raise BusinessRuleError("A bill line refers to another purchase order.")
                if ol.billed_quantity + line.quantity > ol.quantity:
                    raise BusinessRuleError(f"{line.product.sku}: billing exceeds the ordered quantity.", "over_billing")
                PurchaseOrderLine.objects.filter(pk=ol.pk).update(billed_quantity=F("billed_quantity") + line.quantity)
            service_value += line.taxable_amount

    bill.number = next_number(organization, "PB", bill.bill_date)
    bill.fiscal_year = period.fiscal_year
    direct_value = ZERO
    if direct_stock:
        movement, posted = stock.post_stock(
            organization, movement_type=MovementType.RECEIPT, date=bill.bill_date, warehouse=bill.warehouse,
            lines=[stock.StockLine(product=l.product, quantity=l.quantity, unit_cost=rate(l.net_unit_price),
                                   batch_number=l.batch_number, expiry_date=l.expiry_date) for l in direct_stock],
            user=user, reference_type="supplier_bill", reference_id=bill.pk, reference_number=bill.number,
            reason=f"Direct bill {bill.number} ({bill.supplier_invoice_number})",
        )
        bill.stock_movement = movement
        direct_value = sum((p.cost for p in posted), ZERO)
        # Rounding between line totals and layer values goes to purchase price variance.
        variance += sum((l.taxable_amount for l in direct_stock), ZERO) - direct_value

    charges = money(bill.freight) + money(bill.other_charges)
    journal_lines = [
        Line(system_account(organization, SystemAccount.GRNI), debit=grni_value),
        Line(system_account(organization, SystemAccount.PURCHASE_VARIANCE), debit=variance),
        Line(system_account(organization, SystemAccount.INVENTORY), debit=direct_value),
        Line(system_account(organization, SystemAccount.SERVICE_PURCHASES), debit=service_value),
        Line(system_account(organization, SystemAccount.TAX_RECEIVABLE), debit=bill.tax_total),
        Line(system_account(organization, SystemAccount.FREIGHT_IN), debit=charges),
        Line(system_account(organization, SystemAccount.PAYABLE), credit=bill.grand_total, supplier=supplier,
             description=f"Bill {bill.number} / {bill.supplier_invoice_number}"),
    ]
    bill.journal = post_journal(
        organization, date=bill.bill_date, lines=journal_lines, source=JournalSource.PURCHASE_BILL, source_id=bill.pk,
        source_number=bill.number, user=user, idempotency_key=f"PB:{bill.pk}",
        narration=f"Supplier bill {bill.number} ({supplier.name} invoice {bill.supplier_invoice_number})",
    )
    for line in lines:
        line.save()
    bill.status = BillStatus.POSTED
    bill.posted_at = timezone.now()
    bill.posted_by = user
    bill.save()
    refresh_bill_balance(bill)
    if order:
        order.refresh_from_db()
        _refresh_po_status(order)
    _event(request, user, "supplier_bill.posted", bill, new={"grand_total": str(bill.grand_total)})
    return bill


@transaction.atomic
def reverse_bill(bill, user, reason, request=None):
    bill = SupplierBill.objects.select_for_update().get(pk=bill.pk)
    if bill.status != BillStatus.POSTED:
        raise BusinessRuleError("Only posted bills can be reversed.")
    if not reason:
        raise BusinessRuleError("A reason is required.")
    if bill.allocations.filter(is_active=True).exists():
        raise BusinessRuleError("Reverse the payments and debit notes applied to this bill first.")
    if bill.returns.filter(status="POSTED").exists():
        raise BusinessRuleError("This bill has posted returns and cannot be reversed.")
    date = max(timezone.localdate(), bill.bill_date)
    if bill.stock_movement_id:
        stock.reverse_stock(bill.stock_movement, date=date, user=user, reason=reason, reference_type="supplier_bill",
                            reference_id=bill.pk, reference_number=bill.number)
    reverse_journal(bill.journal, date=date, user=user, reason=reason)
    for line in bill.lines.all():
        if line.receipt_line_id:
            GoodsReceiptLine.objects.filter(pk=line.receipt_line_id).update(billed_quantity=F("billed_quantity") - line.quantity)
        if line.order_line_id:
            PurchaseOrderLine.objects.filter(pk=line.order_line_id).update(billed_quantity=F("billed_quantity") - line.quantity)
    bill.status = BillStatus.REVERSED
    bill.reversal_reason = reason
    bill.balance_due = ZERO
    bill.save(update_fields=["status", "reversal_reason", "balance_due", "updated_at"])
    _event(request, user, "supplier_bill.reversed", bill, reason=reason)
    return bill


# --- Purchase returns / debit notes -----------------------------------------------------------


@transaction.atomic
def post_purchase_return(purchase_return, user, request=None):
    from apps.payments.services import allocate_debit_note

    purchase_return = PurchaseReturn.objects.select_for_update().get(pk=purchase_return.pk)
    if purchase_return.status != "DRAFT":
        raise BusinessRuleError("This return has already been posted.", "duplicate_posting")
    bill = SupplierBill.objects.select_for_update().get(pk=purchase_return.bill_id)
    if bill.status != BillStatus.POSTED:
        raise BusinessRuleError("Returns can only be raised against posted bills.")
    if purchase_return.date < bill.bill_date:
        raise BusinessRuleError("The return date cannot be before the bill date.")
    organization = purchase_return.organization
    supplier = bill.supplier
    lines = purchase_return.recalculate(list(purchase_return.lines.select_related("product", "product__unit", "tax_rate")))
    if not lines:
        raise BusinessRuleError("Add at least one line to the return.")
    period = get_posting_period(organization, purchase_return.date)
    stock_lines = []
    service_value = ZERO
    for line in lines:
        bl = SupplierBillLine.objects.select_for_update().get(pk=line.bill_line_id)
        if bl.bill_id != bill.pk:
            raise BusinessRuleError("A return line does not belong to the original bill.")
        if line.quantity > bl.quantity - bl.returned_quantity:
            raise BusinessRuleError(
                f"{line.product.sku}: returning {line.quantity} exceeds the returnable quantity {bl.quantity - bl.returned_quantity}.",
                "over_return",
            )
        bl.returned_quantity += line.quantity
        bl.save(update_fields=["returned_quantity"])
        if line.product.is_stock:
            stock_lines.append(line)
        else:
            service_value += line.taxable_amount
    purchase_return.number = next_number(organization, "PR", purchase_return.date)
    purchase_return.fiscal_year = period.fiscal_year
    cost = ZERO
    if stock_lines:
        movement, posted = stock.post_stock(
            organization, movement_type=MovementType.PURCHASE_RETURN, date=purchase_return.date,
            warehouse=purchase_return.warehouse,
            lines=[stock.StockLine(product=l.product, quantity=-l.quantity, batch_number=l.batch_number,
                                   serial_numbers=l.serial_numbers or []) for l in stock_lines],
            user=user, reference_type="purchase_return", reference_id=purchase_return.pk,
            reference_number=purchase_return.number, reason=f"Return to {supplier.name} against {bill.number}",
        )
        purchase_return.stock_movement = movement
        by_product = {}
        for p in posted:
            by_product.setdefault(p.entry.product_id, []).append(p)
        for line in stock_lines:
            p = by_product[line.product_id].pop(0)
            line.cost_amount = p.cost
            cost += p.cost
    stock_taxable = sum((l.taxable_amount for l in stock_lines), ZERO)
    journal_lines = [
        Line(system_account(organization, SystemAccount.PAYABLE), debit=purchase_return.grand_total, supplier=supplier,
             description=f"Debit note {purchase_return.number}"),
        Line(system_account(organization, SystemAccount.INVENTORY), credit=cost),
        Line(system_account(organization, SystemAccount.PURCHASE_VARIANCE), credit=stock_taxable - cost),
        Line(system_account(organization, SystemAccount.SERVICE_PURCHASES), credit=service_value),
        Line(system_account(organization, SystemAccount.TAX_RECEIVABLE), credit=purchase_return.tax_total),
    ]
    for line in lines:
        line.save()
    purchase_return.journal = post_journal(
        organization, date=purchase_return.date, lines=journal_lines, source=JournalSource.PURCHASE_RETURN,
        source_id=purchase_return.pk, source_number=purchase_return.number, user=user,
        idempotency_key=f"PR:{purchase_return.pk}",
        narration=f"Purchase return / debit note {purchase_return.number} against {bill.number}",
    )
    purchase_return.status = "POSTED"
    purchase_return.posted_at = timezone.now()
    purchase_return.posted_by = user
    purchase_return.save()
    apply_amount = min(bill.balance_due, purchase_return.grand_total)
    if apply_amount > 0:
        allocate_debit_note(purchase_return, [(bill, apply_amount)], user, lock=False)
    _event(request, user, "purchase_return.posted", purchase_return, new={"bill": bill.number, "debit": str(purchase_return.grand_total)})
    return purchase_return


def billable_receipt_lines(order):
    """Accepted-but-unbilled GRN lines of a purchase order."""
    return [
        (rl, rl.accepted_quantity - rl.billed_quantity)
        for rl in GoodsReceiptLine.objects.filter(receipt__purchase_order=order, receipt__status=GRNStatus.POSTED)
        .select_related("product", "order_line", "order_line__tax_rate", "receipt")
        if rl.accepted_quantity > rl.billed_quantity
    ]
