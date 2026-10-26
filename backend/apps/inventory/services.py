"""Inventory posting engine (FIFO).

All stock changes go through ``post_stock``. It runs inside the caller's transaction, locks the
``StockBalance`` rows it touches (in product-id order to avoid deadlocks), writes immutable
``StockLedgerEntry`` rows, maintains FIFO ``CostLayer`` rows and returns the cost of each line so
the caller can post the matching journal in the same transaction.

Costing policy (documented in docs/accounting-rules.md):
* Inbound stock creates a cost layer at the supplied unit cost (GRN: PO net rate; opening stock
  and positive adjustments: entered cost, default last cost; sales returns: original issue cost;
  transfers in: the exact layers that left the source warehouse).
* Outbound stock consumes the oldest layers first (FIFO), restricted to a batch when one is given.
* With negative stock allowed, quantity not covered by layers is costed at the last known unit cost.
"""
from dataclasses import dataclass, field
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from apps.accounting.models import JournalSource, SystemAccount
from apps.accounting.services import Line, post_journal, system_account
from apps.audit.services import record_event
from apps.core.exceptions import BusinessRuleError
from apps.core.money import ZERO, money, qty as q3, rate
from apps.core.numbering import next_number
from apps.fiscal_years.services import get_posting_period
from apps.organizations.models import NegativeStockPolicy

from .models import (
    Batch,
    CostLayer,
    MovementStatus,
    MovementType,
    ReservationStatus,
    SerialNumber,
    SerialStatus,
    StockBalance,
    StockLedgerEntry,
    StockMovement,
    StockMovementLine,
    StockReservation,
    Warehouse,
)


@dataclass
class StockLine:
    product: object
    quantity: Decimal  # signed: positive in, negative out
    unit_cost: Decimal | None = None
    batch_number: str = ""
    expiry_date: object = None
    manufacture_date: object = None
    serial_numbers: list = field(default_factory=list)
    location: object = None
    layers: list | None = None  # inbound only: [(qty, unit_cost, batch)] to recreate exact layers
    total_value: Decimal | None = None  # inbound only: exact value to restore (reversals)
    from_entries: list | None = None  # outbound only: consume only layers created by these ledger entries
    respect_reservations: bool = True


@dataclass
class PostedLine:
    entry: StockLedgerEntry
    cost: Decimal  # absolute value of the stock value moved
    consumed_layers: list  # outbound only: [(qty, unit_cost, batch)]


def warehouse_branch_code(warehouse):
    return warehouse.branch.code if warehouse and warehouse.branch_id else (warehouse.code if warehouse else "")


def _lock_balance(organization, product, warehouse):
    balance, _ = StockBalance.objects.get_or_create(organization=organization, product=product, warehouse=warehouse)
    return StockBalance.objects.select_for_update().get(pk=balance.pk)


def _get_batch(organization, product, line: StockLine, create=False):
    if not line.batch_number:
        return None
    if create:
        batch, created = Batch.objects.get_or_create(
            organization=organization, product=product, batch_number=line.batch_number,
            defaults={"expiry_date": line.expiry_date, "manufacture_date": line.manufacture_date},
        )
        if not created and line.expiry_date and batch.expiry_date and batch.expiry_date != line.expiry_date:
            raise BusinessRuleError(f"Batch {line.batch_number} already exists with expiry {batch.expiry_date}.")
        return batch
    batch = Batch.objects.filter(product=product, batch_number=line.batch_number).first()
    if batch is None:
        raise BusinessRuleError(f"Batch {line.batch_number} does not exist for {product.sku}.")
    return batch


def _validate_tracking(product, line: StockLine, inbound: bool):
    quantity = abs(line.quantity)
    if product.track_batches and not line.batch_number and inbound:
        raise BusinessRuleError(f"{product.sku} is batch-tracked; enter a batch number.")
    if product.track_expiry and inbound and line.batch_number and not line.expiry_date and line.layers is None:
        raise BusinessRuleError(f"{product.sku} tracks expiry; enter an expiry date for batch {line.batch_number}.")
    if product.track_serials:
        if quantity != quantity.to_integral_value():
            raise BusinessRuleError(f"{product.sku} is serial-tracked; quantities must be whole numbers.")
        if len(line.serial_numbers) != int(quantity):
            raise BusinessRuleError(f"{product.sku}: enter exactly {int(quantity)} serial number(s).")
        if len(set(line.serial_numbers)) != len(line.serial_numbers):
            raise BusinessRuleError(f"{product.sku}: serial numbers must be unique.")
    elif line.serial_numbers:
        raise BusinessRuleError(f"{product.sku} is not serial-tracked.")
    if not product.unit.allow_fractions and quantity != quantity.to_integral_value():
        raise BusinessRuleError(f"{product.sku} is sold in whole {product.unit.code}.")


def _serials_in(organization, product, warehouse, batch, serials, movement_type):
    for serial in serials:
        existing = SerialNumber.objects.select_for_update().filter(product=product, serial=serial).first()
        if existing is None:
            SerialNumber.objects.create(organization=organization, product=product, serial=serial, warehouse=warehouse, batch=batch)
            continue
        if existing.status == SerialStatus.IN_STOCK:
            raise BusinessRuleError(f"Serial {serial} of {product.sku} is already in stock.")
        if movement_type == MovementType.RECEIPT and existing.status != SerialStatus.RETURNED_TO_SUPPLIER:
            raise BusinessRuleError(f"Serial {serial} of {product.sku} has already been received.")
        existing.status = SerialStatus.IN_STOCK
        existing.warehouse = warehouse
        existing.save(update_fields=["status", "warehouse", "updated_at"])


def _serials_out(product, warehouse, serials, movement_type):
    status = {
        MovementType.ISSUE: SerialStatus.DELIVERED,
        MovementType.PURCHASE_RETURN: SerialStatus.RETURNED_TO_SUPPLIER,
        MovementType.TRANSFER_OUT: SerialStatus.IN_TRANSIT,
    }.get(movement_type, SerialStatus.WRITTEN_OFF)
    for serial in serials:
        existing = SerialNumber.objects.select_for_update().filter(product=product, serial=serial).first()
        if existing is None or existing.status != SerialStatus.IN_STOCK or existing.warehouse_id != warehouse.id:
            raise BusinessRuleError(f"Serial {serial} of {product.sku} is not in stock at {warehouse.code}.")
        existing.status = status
        existing.save(update_fields=["status", "updated_at"])


def _consume_layers(organization, product, warehouse, quantity, batch, balance, from_entries=None):
    """Consume ``quantity`` (positive) FIFO. Returns (cost, consumed [(qty, cost, batch)], uncovered qty)."""
    layers = CostLayer.objects.select_for_update().filter(
        product=product, warehouse=warehouse, remaining_quantity__gt=0
    ).order_by("date", "id")
    if batch is not None:
        layers = layers.filter(batch=batch)
    if from_entries is not None:
        layers = layers.filter(source_entry_id__in=from_entries)
    remaining = quantity
    cost = ZERO
    consumed = []
    for layer in layers:
        if remaining <= 0:
            break
        take = min(layer.remaining_quantity, remaining)
        layer.remaining_quantity -= take
        layer.save(update_fields=["remaining_quantity"])
        cost += money(take * layer.unit_cost)
        consumed.append((take, layer.unit_cost, layer.batch))
        remaining -= take
    return cost, consumed, remaining


def post_stock(organization, *, movement_type, date, warehouse, lines, user, reason="", notes="",
               reference_type="", reference_id=None, reference_number="", movement=None, check_period=True):
    """Post stock lines. Returns (movement, [PostedLine]). Caller must hold a transaction."""
    if warehouse.organization_id != organization.id:
        raise BusinessRuleError("Warehouse does not belong to this organisation.")
    if not warehouse.is_active:
        raise BusinessRuleError(f"Warehouse {warehouse.code} is inactive.")
    if check_period:
        get_posting_period(organization, date)
    if movement is None:
        movement = StockMovement.objects.create(
            organization=organization, movement_type=movement_type, date=date, warehouse=warehouse, reason=reason,
            notes=notes, reference_type=reference_type, reference_id=reference_id, reference_number=reference_number,
            created_by=user,
        )
    elif movement.status != MovementStatus.DRAFT:
        raise BusinessRuleError(f"Stock movement {movement} has already been posted.", "duplicate_posting")
    movement.number = next_number(organization, "SM", date, warehouse_branch_code(warehouse))
    movement.status = MovementStatus.POSTED
    movement.posted_by = user
    movement.posted_at = timezone.now()
    movement.save()

    allow_negative = organization.negative_stock_policy == NegativeStockPolicy.ALLOW
    posted = []
    for line in sorted(lines, key=lambda l: (l.product.pk, l.quantity)):
        product = line.product
        if product.organization_id != organization.id:
            raise BusinessRuleError("Product does not belong to this organisation.")
        if not product.is_stock:
            raise BusinessRuleError(f"{product.sku} is a non-stock item.")
        quantity = q3(line.quantity)
        if quantity == 0:
            continue
        inbound = quantity > 0
        _validate_tracking(product, line, inbound)
        balance = _lock_balance(organization, product, warehouse)

        if inbound:
            batch = _get_batch(organization, product, line, create=True)
            if line.total_value is not None:
                value = money(line.total_value)
                layer_specs = [(quantity, rate(value / quantity), batch)]
            else:
                layer_specs = line.layers or [(quantity, rate(line.unit_cost if line.unit_cost is not None else balance.last_unit_cost), batch)]
                value = sum((money(lq * lc) for lq, lc, _ in layer_specs), ZERO)
            unit_cost = rate(value / quantity)
            consumed = []
        else:
            out_qty = -quantity
            if line.respect_reservations:
                available = balance.on_hand - balance.reserved
                shortfall_basis = available
            else:
                shortfall_basis = balance.on_hand
            if out_qty > shortfall_basis and not allow_negative:
                raise BusinessRuleError(
                    f"Insufficient stock for {product.sku} at {warehouse.code}: "
                    f"{'available' if line.respect_reservations else 'on hand'} {shortfall_basis}, required {out_qty}.",
                    "insufficient_stock",
                )
            batch = _get_batch(organization, product, line) if line.batch_number else None
            if product.track_batches and batch is None:
                batch_layers = CostLayer.objects.filter(product=product, warehouse=warehouse, remaining_quantity__gt=0)
                if batch_layers.values("batch").distinct().count() > 1:
                    raise BusinessRuleError(f"{product.sku} is batch-tracked; select the batch to issue.")
            cost, consumed, uncovered = _consume_layers(organization, product, warehouse, out_qty, batch, balance,
                                                        line.from_entries)
            if uncovered > 0 and line.from_entries is not None:
                raise BusinessRuleError(f"Stock of {product.sku} from the original document has already been used.")
            if uncovered > 0:
                if batch is not None and not allow_negative:
                    raise BusinessRuleError(f"Batch {batch} of {product.sku} has insufficient quantity at {warehouse.code}.")
                if not allow_negative:
                    raise BusinessRuleError(f"Cost layers for {product.sku} do not cover the issue; run a stock rebuild.")
                cost += money(uncovered * balance.last_unit_cost)
                consumed.append((uncovered, balance.last_unit_cost, batch))
            if balance.on_hand - out_qty == 0:
                cost = balance.value  # clear rounding residue when stock reaches zero
            value = -cost
            unit_cost = rate(cost / out_qty)
            if line.serial_numbers:
                _serials_out(product, warehouse, line.serial_numbers, movement_type)

        balance.on_hand += quantity
        balance.value += value
        if inbound:
            balance.last_unit_cost = unit_cost
        balance.save(update_fields=["on_hand", "value", "last_unit_cost", "updated_at"])

        entry = StockLedgerEntry.objects.create(
            organization=organization, movement=movement, movement_type=movement_type, product=product,
            warehouse=warehouse, location=line.location, batch=batch, date=date, quantity=quantity,
            unit_cost=unit_cost, value=value, balance_quantity=balance.on_hand, balance_value=balance.value,
            reference_type=reference_type or movement_type, reference_id=reference_id or movement.pk,
            reference_number=reference_number or movement.number, serial_numbers=list(line.serial_numbers or []),
            created_by=user,
        )
        if inbound:
            for layer_qty, layer_cost, layer_batch in layer_specs:
                CostLayer.objects.create(
                    organization=organization, product=product, warehouse=warehouse, batch=layer_batch or batch,
                    source_entry=entry, date=date, original_quantity=layer_qty, remaining_quantity=layer_qty,
                    unit_cost=layer_cost,
                )
            if line.serial_numbers:
                _serials_in(organization, product, warehouse, batch, line.serial_numbers, movement_type)
        posted.append(PostedLine(entry=entry, cost=abs(value), consumed_layers=consumed))
    if not posted:
        raise BusinessRuleError("The movement has no stock lines to post.")
    return movement, posted


def reverse_stock(movement, *, date, user, reason, reference_type="", reference_id=None, reference_number=""):
    """Post the exact opposite of a posted movement and return (reversal movement, net value change).

    Outbound entries are restored at their original value; inbound entries are removed from the
    very layers they created, which must still be untouched. The caller reverses the journal.
    """
    lines = []
    for entry in movement.ledger_entries.select_related("product", "product__unit", "batch").order_by("id"):
        batch_number = entry.batch.batch_number if entry.batch else ""
        if entry.quantity < 0:
            lines.append(StockLine(product=entry.product, quantity=-entry.quantity, total_value=-entry.value,
                                   batch_number=batch_number, expiry_date=entry.batch.expiry_date if entry.batch else None,
                                   serial_numbers=entry.serial_numbers or []))
        else:
            layers = list(entry.layers.select_for_update())
            if any(layer.remaining_quantity != layer.original_quantity for layer in layers):
                raise BusinessRuleError(
                    f"Stock of {entry.product.sku} from {movement.number} has already been used; "
                    "post a return or adjustment instead."
                )
            lines.append(StockLine(product=entry.product, quantity=-entry.quantity, batch_number=batch_number,
                                   serial_numbers=entry.serial_numbers or [], from_entries=[entry.pk]))
    reversal = StockMovement.objects.create(
        organization=movement.organization, movement_type=MovementType.REVERSAL, date=date, warehouse=movement.warehouse,
        reason=f"Reversal of {movement.number}: {reason}", reference_type=reference_type or "stock_movement",
        reference_id=reference_id or movement.pk, reference_number=reference_number or movement.number,
        reversal_of=movement, created_by=user,
    )
    reversal, posted = post_stock(
        movement.organization, movement_type=MovementType.REVERSAL, date=date, warehouse=movement.warehouse, lines=lines,
        user=user, movement=reversal, reference_type=reversal.reference_type, reference_id=reversal.reference_id,
        reference_number=reversal.reference_number,
    )
    movement.status = MovementStatus.REVERSED
    movement.save(update_fields=["status", "updated_at"])
    return reversal, sum((p.entry.value for p in posted), ZERO)


# --- Manual movements (opening stock, adjustments, write-offs) -------------------------------

MANUAL_GL = {
    # movement type: (account when stock increases, account when stock decreases)
    MovementType.OPENING: SystemAccount.OPENING_EQUITY,
    MovementType.ADJUSTMENT: SystemAccount.STOCK_ADJUSTMENT,
    MovementType.DAMAGE: SystemAccount.STOCK_ADJUSTMENT,
    MovementType.COUNT: SystemAccount.STOCK_ADJUSTMENT,
}


def _manual_journal(movement, posted, user):
    organization = movement.organization
    inventory = system_account(organization, SystemAccount.INVENTORY)
    contra = system_account(organization, MANUAL_GL[movement.movement_type])
    net = sum((p.entry.value for p in posted), ZERO)
    if net == 0:
        return None
    lines = [Line(inventory, debit=net), Line(contra, credit=net)]
    return post_journal(
        organization, date=movement.date, lines=lines, source=JournalSource.STOCK, source_id=movement.pk,
        source_number=movement.number, narration=f"{movement.get_movement_type_display()} {movement.number}: {movement.reason}",
        user=user, idempotency_key=f"SM:{movement.pk}",
    )


@transaction.atomic
def post_manual_movement(movement, user, request=None):
    movement = StockMovement.objects.select_for_update().get(pk=movement.pk)
    if movement.status != MovementStatus.DRAFT:
        raise BusinessRuleError("Only draft movements can be posted.", "duplicate_posting")
    if movement.movement_type not in MANUAL_GL:
        raise BusinessRuleError("This movement type is posted by its source document.")
    lines = []
    for line in movement.lines.select_related("product", "product__unit"):
        quantity = line.quantity
        if movement.movement_type in (MovementType.OPENING,) and quantity <= 0:
            raise BusinessRuleError("Opening stock quantities must be positive.")
        if movement.movement_type == MovementType.DAMAGE:
            quantity = -abs(quantity)
        if quantity > 0 and line.unit_cost is None and movement.movement_type == MovementType.OPENING:
            raise BusinessRuleError(f"Enter the unit cost of opening stock for {line.product.sku}.")
        lines.append(StockLine(
            product=line.product, quantity=quantity, unit_cost=line.unit_cost, batch_number=line.batch_number,
            expiry_date=line.expiry_date, serial_numbers=line.serial_numbers or [], location=line.location,
        ))
    movement, posted = post_stock(
        movement.organization, movement_type=movement.movement_type, date=movement.date, warehouse=movement.warehouse,
        lines=lines, user=user, reason=movement.reason, movement=movement,
    )
    movement.journal = _manual_journal(movement, posted, user)
    movement.save(update_fields=["journal"])
    record_event(request or user, "stock_movement.posted", "stock_movement", movement, organization=movement.organization)
    return movement


@transaction.atomic
def reverse_movement(movement, user, reason, date=None, request=None):
    """Reverse a manual movement (opening stock, adjustment, write-off) and its journal."""
    from apps.accounting.services import reverse_journal

    movement = StockMovement.objects.select_for_update().get(pk=movement.pk)
    if movement.status != MovementStatus.POSTED:
        raise BusinessRuleError("Only posted movements can be reversed.")
    if movement.movement_type not in MANUAL_GL:
        raise BusinessRuleError("Reverse the source document instead of its stock movement.")
    if not reason:
        raise BusinessRuleError("A reason is required to reverse a movement.")
    date = date or max(movement.date, timezone.localdate())
    reversal, _ = reverse_stock(movement, date=date, user=user, reason=reason)
    if movement.journal_id:
        reversal.journal = reverse_journal(movement.journal, date=date, user=user, reason=reason)
        reversal.save(update_fields=["journal"])
    record_event(request or user, "stock_movement.reversed", "stock_movement", movement, reason=reason,
                 organization=movement.organization)
    return reversal


# --- Reservations ---------------------------------------------------------------------------


def reserve(order_line, warehouse, quantity, user=None):
    """Reserve up to ``quantity`` of available stock for a sales order line. Returns the quantity reserved."""
    product = order_line.product
    if not product.is_stock or quantity <= 0:
        return ZERO
    balance = _lock_balance(order_line.order.organization, product, warehouse)
    reservable = max(min(balance.on_hand - balance.reserved, quantity), ZERO)
    if reservable <= 0:
        return ZERO
    balance.reserved += reservable
    balance.save(update_fields=["reserved", "updated_at"])
    StockReservation.objects.create(
        organization=order_line.order.organization, product=product, warehouse=warehouse,
        sales_order_line=order_line, quantity=reservable, open_quantity=reservable,
    )
    order_line.reserved_quantity += reservable
    order_line.save(update_fields=["reserved_quantity"])
    return reservable


def release(order_line, warehouse, quantity=None, consumed=False):
    """Release (or mark consumed by a delivery) open reservations of an order line, oldest first."""
    product = order_line.product
    if not product.is_stock:
        return ZERO
    to_release = order_line.reserved_quantity if quantity is None else min(quantity, order_line.reserved_quantity)
    if to_release <= 0:
        return ZERO
    balance = _lock_balance(order_line.order.organization, product, warehouse)
    remaining = to_release
    for reservation in StockReservation.objects.select_for_update().filter(
        sales_order_line=order_line, status=ReservationStatus.ACTIVE
    ).order_by("created_at", "id"):
        take = min(reservation.open_quantity, remaining)
        reservation.open_quantity -= take
        if reservation.open_quantity == 0:
            reservation.status = ReservationStatus.CONSUMED if consumed else ReservationStatus.RELEASED
        reservation.save(update_fields=["open_quantity", "status", "updated_at"])
        remaining -= take
        if remaining <= 0:
            break
    balance.reserved = max(balance.reserved - to_release, ZERO)
    balance.save(update_fields=["reserved", "updated_at"])
    order_line.reserved_quantity -= to_release
    order_line.save(update_fields=["reserved_quantity"])
    return to_release


# --- Transfers --------------------------------------------------------------------------------


def transit_warehouse(organization):
    warehouse, _ = Warehouse.objects.get_or_create(
        organization=organization, is_transit=True, defaults={"code": "TRANSIT", "name": "Goods in transit"}
    )
    return warehouse


@transaction.atomic
def dispatch_transfer(transfer, user, request=None):
    from .models import StockTransfer, TransferStatus

    transfer = StockTransfer.objects.select_for_update().get(pk=transfer.pk)
    if transfer.status != TransferStatus.DRAFT:
        raise BusinessRuleError("Only draft transfers can be dispatched.", "duplicate_posting")
    organization = transfer.organization
    transfer.number = next_number(organization, "ST", transfer.date, warehouse_branch_code(transfer.source_warehouse))
    transit = transit_warehouse(organization)
    lines = list(transfer.lines.select_related("product", "product__unit"))
    if not lines:
        raise BusinessRuleError("Add at least one line to the transfer.")
    out_movement, posted = post_stock(
        organization, movement_type=MovementType.TRANSFER_OUT, date=transfer.date, warehouse=transfer.source_warehouse,
        lines=[StockLine(product=l.product, quantity=-l.quantity, batch_number=l.batch_number,
                         serial_numbers=l.serial_numbers or []) for l in lines],
        user=user, reference_type="stock_transfer", reference_id=transfer.pk, reference_number=transfer.number,
        reason=f"Transfer to {transfer.destination_warehouse.code}",
    )
    in_lines = []
    by_product = {p.entry.product_id: p for p in posted}
    for line in lines:
        p = by_product[line.product_id]
        in_lines.append(StockLine(product=line.product, quantity=line.quantity, layers=p.consumed_layers,
                                  batch_number=line.batch_number, serial_numbers=line.serial_numbers or []))
    post_stock(
        organization, movement_type=MovementType.TRANSFER_IN, date=transfer.date, warehouse=transit, lines=in_lines,
        user=user, reference_type="stock_transfer", reference_id=transfer.pk, reference_number=transfer.number,
        reason=f"In transit {transfer.source_warehouse.code} → {transfer.destination_warehouse.code}",
    )
    transfer.status = TransferStatus.IN_TRANSIT
    transfer.dispatched_at = timezone.now()
    transfer.dispatched_by = user
    transfer.dispatch_movement = out_movement
    transfer.save()
    record_event(request or user, "transfer.dispatched", "stock_transfer", transfer, organization=organization)
    return transfer


@transaction.atomic
def receive_transfer(transfer, user, date=None, request=None):
    from .models import StockTransfer, TransferStatus

    transfer = StockTransfer.objects.select_for_update().get(pk=transfer.pk)
    if transfer.status != TransferStatus.IN_TRANSIT:
        raise BusinessRuleError("Only transfers in transit can be received.", "duplicate_posting")
    organization = transfer.organization
    date = date or timezone.localdate()
    if date < transfer.date:
        raise BusinessRuleError("The receipt date cannot be before the dispatch date.")
    transit = transit_warehouse(organization)
    lines = list(transfer.lines.select_related("product", "product__unit"))
    _, posted = post_stock(
        organization, movement_type=MovementType.TRANSFER_OUT, date=date, warehouse=transit,
        lines=[StockLine(product=l.product, quantity=-l.quantity, batch_number=l.batch_number,
                         serial_numbers=l.serial_numbers or [], respect_reservations=False) for l in lines],
        user=user, reference_type="stock_transfer", reference_id=transfer.pk, reference_number=transfer.number,
        reason=f"Arrived at {transfer.destination_warehouse.code}",
    )
    by_product = {p.entry.product_id: p for p in posted}
    in_movement, _ = post_stock(
        organization, movement_type=MovementType.TRANSFER_IN, date=date, warehouse=transfer.destination_warehouse,
        lines=[StockLine(product=l.product, quantity=l.quantity, layers=by_product[l.product_id].consumed_layers,
                         batch_number=l.batch_number, serial_numbers=l.serial_numbers or []) for l in lines],
        user=user, reference_type="stock_transfer", reference_id=transfer.pk, reference_number=transfer.number,
        reason=f"Transfer from {transfer.source_warehouse.code}",
    )
    transfer.status = TransferStatus.RECEIVED
    transfer.received_date = date
    transfer.received_by = user
    transfer.receipt_movement = in_movement
    transfer.save()
    record_event(request or user, "transfer.received", "stock_transfer", transfer, organization=organization)
    return transfer


# --- Stock counts -----------------------------------------------------------------------------


def on_hand(product, warehouse):
    balance = StockBalance.objects.filter(product=product, warehouse=warehouse).first()
    return balance.on_hand if balance else ZERO


@transaction.atomic
def post_count(count, user, request=None):
    """Post a stock count: the adjustment is counted − on hand at posting time, per line."""
    from .models import CountStatus, StockCount

    count = StockCount.objects.select_for_update().get(pk=count.pk)
    if count.status != CountStatus.DRAFT:
        raise BusinessRuleError("This count has already been posted.", "duplicate_posting")
    lines = list(count.lines.select_related("product", "product__unit"))
    if any(line.counted_quantity is None for line in lines):
        raise BusinessRuleError("Enter a counted quantity for every line before posting.")
    organization = count.organization
    count.number = count.number or next_number(organization, "SC", count.date, warehouse_branch_code(count.warehouse))
    adjustments = []
    for line in lines:
        diff = line.counted_quantity - on_hand(line.product, count.warehouse)
        if diff != 0:
            adjustments.append(StockLine(product=line.product, quantity=diff, respect_reservations=False))
    if adjustments:
        movement, posted = post_stock(
            organization, movement_type=MovementType.COUNT, date=count.date, warehouse=count.warehouse,
            lines=adjustments, user=user, reason=f"Stock count {count.number}",
            reference_type="stock_count", reference_id=count.pk, reference_number=count.number,
        )
        movement.journal = _manual_journal(movement, posted, user)
        movement.save(update_fields=["journal"])
        count.adjustment_movement = movement
    count.status = CountStatus.POSTED
    count.posted_by = user
    count.posted_at = timezone.now()
    count.save()
    record_event(request or user, "stock_count.posted", "stock_count", count, organization=organization)
    return count


# --- Verification -----------------------------------------------------------------------------


def verify_balances(organization):
    """Compare StockBalance with the ledger. Returns a list of mismatches (empty when consistent)."""
    from django.db.models import Sum

    problems = []
    ledger = {
        (row["product"], row["warehouse"]): (row["q"], row["v"])
        for row in StockLedgerEntry.objects.filter(organization=organization)
        .values("product", "warehouse").annotate(q=Sum("quantity"), v=Sum("value"))
    }
    for balance in StockBalance.objects.filter(organization=organization):
        q, v = ledger.get((balance.product_id, balance.warehouse_id), (ZERO, ZERO))
        if q != balance.on_hand or v != balance.value:
            problems.append({"product": balance.product_id, "warehouse": balance.warehouse_id,
                             "balance": (balance.on_hand, balance.value), "ledger": (q, v)})
    return problems
