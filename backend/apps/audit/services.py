import datetime as dt
import decimal
import logging

from django.db import models

from apps.core.context import request_id_var, request_ip_var

logger = logging.getLogger("audit")

SENSITIVE_FIELDS = {"password", "bank_account_number", "token"}


def _jsonable(value):
    if isinstance(value, (dt.date, dt.datetime)):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        return str(value)
    if isinstance(value, models.Model):
        return value.pk
    if hasattr(value, "name") and hasattr(value, "url"):
        return value.name or None
    return value


def snapshot(instance, fields=None):
    """Concrete field values of a model instance (FKs as ids, sensitive fields masked)."""
    data = {}
    for field in instance._meta.concrete_fields:
        name = field.attname
        if fields and field.name not in fields and name not in fields:
            continue
        if field.name in ("created_at", "updated_at"):
            continue
        value = getattr(instance, name)
        data[field.name] = "***" if field.name in SENSITIVE_FIELDS and value else _jsonable(value)
    return data


def diff(old, new):
    if not old or not new:
        return old, new
    changed = [key for key in new if old.get(key) != new.get(key)]
    return {k: old.get(k) for k in changed}, {k: new.get(k) for k in changed}


def record_event(request_or_user, action, entity_type, instance=None, *, entity_id=None, label=None,
                 old=None, new=None, reason="", organization=None):
    from .models import AuditEvent

    user = getattr(request_or_user, "user", request_or_user)
    if user is not None and not getattr(user, "is_authenticated", False):
        user = None
    if organization is None:
        organization = getattr(request_or_user, "organization", None) or getattr(instance, "organization", None)
    if old is not None and new is not None:
        old, new = diff(old, new)
    event = AuditEvent.objects.create(
        organization=organization,
        user=user,
        action=action,
        entity_type=entity_type,
        entity_id=str(entity_id if entity_id is not None else getattr(instance, "pk", "")),
        entity_label=(label or (str(instance) if instance is not None else ""))[:200],
        old_values=old,
        new_values=new,
        reason=reason or "",
        request_id=request_id_var.get(),
        ip_address=request_ip_var.get(),
    )
    logger.info("audit %s %s %s", action, entity_type, event.entity_id)
    return event
