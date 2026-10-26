"""Per-request context shared by logging and the audit trail."""
from contextvars import ContextVar

request_id_var: ContextVar[str] = ContextVar("request_id", default="-")
request_ip_var: ContextVar[str | None] = ContextVar("request_ip", default=None)
