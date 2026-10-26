"""Decimal helpers. Money is stored with 2 decimal places, quantities with 3, unit costs with 4."""
from decimal import ROUND_HALF_UP, Decimal

ZERO = Decimal("0")
MONEY = Decimal("0.01")
QTY = Decimal("0.001")
RATE = Decimal("0.0001")

MONEY_DIGITS = dict(max_digits=18, decimal_places=2)
QTY_DIGITS = dict(max_digits=16, decimal_places=3)
RATE_DIGITS = dict(max_digits=18, decimal_places=4)
PERCENT_DIGITS = dict(max_digits=7, decimal_places=4)


def D(value) -> Decimal:
    if value is None or value == "":
        return ZERO
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


def money(value) -> Decimal:
    return D(value).quantize(MONEY, rounding=ROUND_HALF_UP)


def qty(value) -> Decimal:
    return D(value).quantize(QTY, rounding=ROUND_HALF_UP)


def rate(value) -> Decimal:
    return D(value).quantize(RATE, rounding=ROUND_HALF_UP)
