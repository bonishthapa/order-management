"""Report registry.

Every report returns the same structure so the UI, CSV/Excel export and PDF share one renderer:

    {"title", "basis", "range", "columns": [{key, label, type}], "rows": [...], "totals": {...}, "notes": [...]}

``basis`` explains exactly how the figures are calculated. Revenue (invoiced, excluding tax),
cash received (receipts) and profit (revenue − cost) are separate reports and never mixed.
"""
from dataclasses import dataclass, field
from typing import Callable

REPORTS = {}


@dataclass
class ReportDef:
    slug: str
    title: str
    group: str
    permission: str
    func: Callable
    basis: str
    params: list = field(default_factory=list)  # extra parameters the UI should offer
    period: str = "range"  # range | as_of | none


def report(slug, title, group, permission, basis, params=None, period="range"):
    def decorator(func):
        REPORTS[slug] = ReportDef(slug, title, group, permission, func, basis, params or [], period)
        return func

    return decorator


def col(key, label, kind="text"):
    return {"key": key, "label": label, "type": kind}
