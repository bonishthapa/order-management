"""Connected-document graph used by the transaction timeline.

Sales Order → Deliveries → Invoices → Receipts / Credit notes → Journals
Purchase Order → GRNs → Bills → Payment vouchers / Debit notes → Journals
plus the stock movements and journals each document produced.
"""
from apps.calendar_utils.fields import bs_or_none


def _doc(kind, obj, *, date=None, amount=None, label=None, relation=""):
    if obj is None:
        return None
    return {
        "type": kind,
        "id": obj.pk,
        "number": getattr(obj, "number", "") or f"Draft #{obj.pk}",
        "date": date.isoformat() if date else None,
        "date_bs": bs_or_none(date) if date else None,
        "status": getattr(obj, "status", None),
        "amount": str(amount) if amount is not None else None,
        "label": label or "",
        "relation": relation,
    }


def _journal(entry, relation):
    return _doc("journal", entry, date=entry.date, amount=entry.total_debit, label=entry.get_source_display(),
                relation=relation) if entry else None


def _movement(movement, relation="Stock movement"):
    return _doc("stock-movement", movement, date=movement.date, label=movement.get_movement_type_display(),
                relation=relation) if movement else None


def _sales_order(order):
    out = [_doc("sales-order", order, date=order.order_date, amount=order.grand_total, relation="Sales order")]
    for d in order.deliveries.exclude(status="CANCELLED"):
        out.append(_doc("delivery", d, date=d.date, relation="Delivery"))
    for inv in order.invoices.exclude(status="CANCELLED"):
        out.extend(_invoice(inv, include_order=False))
    return out


def _invoice(invoice, include_order=True):
    out = []
    if include_order and invoice.sales_order_id:
        out.append(_doc("sales-order", invoice.sales_order, date=invoice.sales_order.order_date,
                        amount=invoice.sales_order.grand_total, relation="Sales order"))
        for d in invoice.sales_order.deliveries.filter(status="POSTED"):
            out.append(_doc("delivery", d, date=d.date, relation="Delivery"))
    out.append(_doc("sales-invoice", invoice, date=invoice.invoice_date, amount=invoice.grand_total, relation="Invoice"))
    for alloc in invoice.allocations.select_related("receipt", "credit_note"):
        if alloc.receipt_id:
            out.append(_doc("sales-receipt", alloc.receipt, date=alloc.receipt.date, amount=alloc.amount,
                            label="Allocation reversed" if not alloc.is_active else "", relation="Receipt"))
        else:
            out.append(_doc("sales-return", alloc.credit_note, date=alloc.credit_note.date, amount=alloc.amount,
                            relation="Credit note"))
    for ret in invoice.returns.exclude(status="CANCELLED"):
        if not any(d and d["type"] == "sales-return" and d["id"] == ret.pk for d in out):
            out.append(_doc("sales-return", ret, date=ret.date, amount=ret.grand_total, relation="Return"))
    out.append(_journal(invoice.journal, "Revenue journal"))
    out.append(_journal(invoice.cogs_journal, "Cost of sales journal"))
    out.append(_movement(invoice.stock_movement))
    return out


def _purchase_order(order):
    out = [_doc("purchase-order", order, date=order.order_date, amount=order.grand_total, relation="Purchase order")]
    for g in order.receipts.exclude(status="CANCELLED"):
        out.append(_doc("goods-received-note", g, date=g.date, amount=g.total_value, relation="Goods received"))
    for bill in order.bills.exclude(status="CANCELLED"):
        out.extend(_bill(bill, include_order=False))
    return out


def _bill(bill, include_order=True):
    out = []
    if include_order and bill.purchase_order_id:
        po = bill.purchase_order
        out.append(_doc("purchase-order", po, date=po.order_date, amount=po.grand_total, relation="Purchase order"))
        for g in po.receipts.filter(status="POSTED"):
            out.append(_doc("goods-received-note", g, date=g.date, amount=g.total_value, relation="Goods received"))
    out.append(_doc("purchase-bill", bill, date=bill.bill_date, amount=bill.grand_total, relation="Supplier bill"))
    for alloc in bill.allocations.select_related("voucher", "debit_note"):
        if alloc.voucher_id:
            out.append(_doc("payment-voucher", alloc.voucher, date=alloc.voucher.date, amount=alloc.amount,
                            label="Allocation reversed" if not alloc.is_active else "", relation="Payment"))
        else:
            out.append(_doc("purchase-return", alloc.debit_note, date=alloc.debit_note.date, amount=alloc.amount,
                            relation="Debit note"))
    out.append(_journal(bill.journal, "Purchase journal"))
    out.append(_movement(bill.stock_movement))
    return out


def related_documents(obj):
    from apps.accounting.models import JournalEntry
    from apps.expenses.models import Expense
    from apps.inventory.models import StockCount, StockMovement, StockTransfer
    from apps.payments.models import CustomerReceipt, PaymentVoucher
    from apps.purchases.models import GoodsReceipt, PurchaseOrder, PurchaseReturn, SupplierBill
    from apps.sales.models import Delivery, SalesInvoice, SalesOrder, SalesReturn

    out = []
    if isinstance(obj, SalesOrder):
        out = _sales_order(obj)
    elif isinstance(obj, Delivery):
        out = _sales_order(obj.sales_order) + [_journal(obj.journal, "Cost of sales journal"), _movement(obj.stock_movement)]
    elif isinstance(obj, SalesInvoice):
        out = _invoice(obj)
    elif isinstance(obj, SalesReturn):
        out = _invoice(obj.invoice) + [_journal(obj.journal, "Credit note journal"), _movement(obj.stock_movement)]
        out += [_doc("customer-refund", r, date=r.date, amount=r.amount, relation="Refund") for r in obj.refunds.all()]
    elif isinstance(obj, CustomerReceipt):
        out = [_doc("sales-receipt", obj, date=obj.date, amount=obj.amount, relation="Receipt")]
        for alloc in obj.allocations.select_related("invoice"):
            out.append(_doc("sales-invoice", alloc.invoice, date=alloc.invoice.invoice_date, amount=alloc.amount,
                            relation="Allocated to"))
        out += [_doc("customer-refund", r, date=r.date, amount=r.amount, relation="Refund") for r in obj.refunds.all()]
        out.append(_journal(obj.journal, "Receipt journal"))
    elif isinstance(obj, PurchaseOrder):
        out = _purchase_order(obj)
    elif isinstance(obj, GoodsReceipt):
        out = _purchase_order(obj.purchase_order) + [_journal(obj.journal, "Receipt journal"), _movement(obj.stock_movement)]
    elif isinstance(obj, SupplierBill):
        out = _bill(obj)
    elif isinstance(obj, PurchaseReturn):
        out = _bill(obj.bill) + [_journal(obj.journal, "Debit note journal"), _movement(obj.stock_movement)]
    elif isinstance(obj, PaymentVoucher):
        out = [_doc("payment-voucher", obj, date=obj.date, amount=obj.amount, relation="Payment")]
        for alloc in obj.allocations.select_related("bill"):
            out.append(_doc("purchase-bill", alloc.bill, date=alloc.bill.bill_date, amount=alloc.amount, relation="Allocated to"))
        out.append(_journal(obj.journal, "Payment journal"))
    elif isinstance(obj, Expense):
        out = [_doc("expense", obj, date=obj.date, amount=obj.total, relation="Expense"), _journal(obj.journal, "Expense journal")]
    elif isinstance(obj, JournalEntry):
        out = [_journal(obj, "Journal")]
        if obj.reversal_of_id:
            out.append(_journal(obj.reversal_of, "Reverses"))
        reversed_by = JournalEntry.objects.filter(reversal_of=obj).first()
        if reversed_by:
            out.append(_journal(reversed_by, "Reversed by"))
    elif isinstance(obj, StockTransfer):
        out = [_doc("stock-transfer", obj, date=obj.date, label=f"{obj.source_warehouse.code} → {obj.destination_warehouse.code}",
                    relation="Transfer")]
        for m in StockMovement.objects.filter(organization=obj.organization, reference_type="stock_transfer", reference_id=obj.pk):
            out.append(_movement(m, f"{m.get_movement_type_display()} · {m.warehouse.code}"))
    elif isinstance(obj, StockCount):
        out = [_doc("stock-count", obj, date=obj.date, relation="Count"), _movement(obj.adjustment_movement, "Adjustment")]
        if obj.adjustment_movement_id:
            out.append(_journal(obj.adjustment_movement.journal, "Journal"))
    elif isinstance(obj, StockMovement):
        out = [_movement(obj, "Movement"), _journal(obj.journal, "Journal")]
    # Drop empties and duplicates while keeping order.
    seen, result = set(), []
    for item in out:
        if item is None:
            continue
        key = (item["type"], item["id"], item["relation"])
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result
