"""Number and date formatting shared by PDFs and exports."""
import datetime as dt
from decimal import Decimal

from apps.calendar_utils.bs import BSDateError, ad_to_bs


def group_digits(integer_part: str, style: str) -> str:
    if len(integer_part) <= 3:
        return integer_part
    if style == "lakh":
        head, tail = integer_part[:-3], integer_part[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        return ",".join(groups + [tail])
    groups = []
    while integer_part:
        groups.insert(0, integer_part[-3:])
        integer_part = integer_part[:-3]
    return ",".join(groups)


def grouping_style(organization):
    locale = (getattr(organization, "locale", "") or "").upper()
    return "lakh" if locale.endswith("NP") or locale.endswith("IN") else "thousand"


def format_amount(value, organization=None, places=2):
    if value is None or value == "":
        return ""
    value = Decimal(str(value))
    sign = "-" if value < 0 else ""
    text = f"{abs(value):.{places}f}"
    integer, _, fraction = text.partition(".")
    grouped = group_digits(integer, grouping_style(organization))
    return f"{sign}{grouped}.{fraction}" if places else f"{sign}{grouped}"


def format_quantity(value):
    if value is None:
        return ""
    value = Decimal(str(value)).normalize()
    text = format(value, "f")
    return text


def format_date(value, mode="AD_BS"):
    """Render a business date according to a display mode (AD, BS or AD_BS)."""
    if not value:
        return ""
    if isinstance(value, str):
        value = dt.date.fromisoformat(value)
    if isinstance(value, dt.datetime):
        value = value.date()
    ad = value.isoformat()
    try:
        bs = ad_to_bs(value).isoformat()
    except BSDateError:
        bs = ""
    if mode == "AD" or not bs:
        return ad
    if mode == "BS":
        return f"{bs} BS"
    return f"{bs} BS ({ad} AD)"


AMOUNT_WORDS_ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven",
                     "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"]
AMOUNT_WORDS_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]


def _words_below_1000(n):
    words = []
    if n >= 100:
        words.append(f"{AMOUNT_WORDS_ONES[n // 100]} Hundred")
        n %= 100
    if n >= 20:
        words.append(AMOUNT_WORDS_TENS[n // 10] + (f"-{AMOUNT_WORDS_ONES[n % 10]}" if n % 10 else ""))
    elif n:
        words.append(AMOUNT_WORDS_ONES[n])
    return " ".join(words)


def amount_in_words(value, currency="Rupees", subunit="Paisa"):
    """South-Asian numbering (crore, lakh, thousand), e.g. 'Rupees One Lakh Twenty Thousand Only'."""
    value = Decimal(str(value or 0)).quantize(Decimal("0.01"))
    whole = int(abs(value))
    paisa = int((abs(value) - whole) * 100)
    parts = []
    for size, label in ((10_000_000, "Crore"), (100_000, "Lakh"), (1000, "Thousand")):
        if whole >= size:
            parts.append(f"{_words_below_1000(whole // size) if whole // size < 1000 else amount_in_words(whole // size, '', '').strip()} {label}")
            whole %= size
    if whole:
        parts.append(_words_below_1000(whole))
    text = " ".join(parts) or "Zero"
    result = f"{currency} {text}".strip()
    if paisa:
        result += f" and {_words_below_1000(paisa)} {subunit}"
    return result + " Only"
