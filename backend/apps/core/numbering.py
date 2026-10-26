"""Concurrency-safe document numbering.

A number is issued by a single ``INSERT ... ON CONFLICT DO UPDATE ... RETURNING`` on
``core_documentsequence``. The upsert takes a row lock that is held until the surrounding
transaction ends, so concurrent postings queue on the counter, and a rolled-back posting also
rolls back its increment (no gaps from failed postings, no duplicates ever). Numbers are never
derived from counting existing documents.

Format: ``<prefix><sep>[<branch><sep>][<scope><sep>]<zero-padded sequence>``
e.g. ``SI-2083/84-000001`` (fiscal-year reset) or ``PO-000123`` (continuous).
"""
from django.db import connection

from apps.calendar_utils.bs import ad_to_bs
from apps.core.exceptions import BusinessRuleError

DEFAULT_PREFIXES = {
    "SO": "SO", "DN": "DN", "SI": "SI", "RC": "RC", "RF": "RF", "SR": "CN",
    "PO": "PO", "GRN": "GRN", "PB": "PB", "PV": "PV", "PR": "DBN",
    "EX": "EX", "JV": "JV", "SM": "SM", "ST": "ST", "SC": "SC",
}

_UPSERT = """
INSERT INTO core_documentsequence (organization_id, doc_type, scope, last_value, updated_at)
VALUES (%s, %s, %s, 1, NOW())
ON CONFLICT (organization_id, doc_type, scope)
DO UPDATE SET last_value = core_documentsequence.last_value + 1, updated_at = NOW()
RETURNING last_value
"""


def get_policy(organization, doc_type):
    from apps.organizations.models import NumberingPolicy, ResetPolicy

    policy = NumberingPolicy.objects.filter(organization=organization, doc_type=doc_type).first()
    if policy is None:
        policy = NumberingPolicy(
            organization=organization,
            doc_type=doc_type,
            prefix=DEFAULT_PREFIXES.get(doc_type, doc_type),
            reset_policy=ResetPolicy.FISCAL_YEAR,
        )
    return policy


def _scope(policy, organization, date):
    from apps.fiscal_years.models import FiscalYear
    from apps.organizations.models import ResetPolicy

    if policy.reset_policy == ResetPolicy.FISCAL_YEAR:
        fiscal_year = FiscalYear.for_date(organization, date)
        if fiscal_year is None:
            raise BusinessRuleError(
                f"No fiscal year covers {date.isoformat()}. Create the fiscal year before issuing documents.",
                "no_fiscal_year",
            )
        return fiscal_year.code
    if policy.reset_policy == ResetPolicy.CALENDAR_AD:
        return str(date.year)
    if policy.reset_policy == ResetPolicy.CALENDAR_BS:
        return str(ad_to_bs(date).year)
    return ""


def format_number(policy, sequence, scope="", branch_code=""):
    parts = [policy.prefix]
    if policy.include_branch and branch_code:
        parts.append(branch_code)
    if scope:
        parts.append(scope)
    parts.append(str(sequence).zfill(policy.padding))
    return policy.separator.join(parts)


def next_number(organization, doc_type, date, branch_code=""):
    """Issue the next number. Must be called inside the posting transaction."""
    if not connection.in_atomic_block:
        raise RuntimeError("next_number must run inside transaction.atomic()")
    policy = get_policy(organization, doc_type)
    scope = _scope(policy, organization, date)
    counter_scope = f"{branch_code}|{scope}" if policy.include_branch and branch_code else scope
    with connection.cursor() as cursor:
        cursor.execute(_UPSERT, [organization.id, doc_type, counter_scope])
        sequence = cursor.fetchone()[0]
    return format_number(policy, sequence, scope, branch_code)


def preview_number(organization, doc_type, date, branch_code=""):
    """The number the next document would receive (informational only; not reserved)."""
    from .models import DocumentSequence

    policy = get_policy(organization, doc_type)
    scope = _scope(policy, organization, date)
    counter_scope = f"{branch_code}|{scope}" if policy.include_branch and branch_code else scope
    row = DocumentSequence.objects.filter(organization=organization, doc_type=doc_type, scope=counter_scope).first()
    return format_number(policy, (row.last_value if row else 0) + 1, scope, branch_code)


def next_code(organization, key, prefix, padding=5):
    """Continuous master-data code (customers, suppliers, products), e.g. ``CUS-00042``."""
    if not connection.in_atomic_block:
        raise RuntimeError("next_code must run inside transaction.atomic()")
    with connection.cursor() as cursor:
        cursor.execute(_UPSERT, [organization.id, f"code:{key}", ""])
        sequence = cursor.fetchone()[0]
    return f"{prefix}-{str(sequence).zfill(padding)}"
