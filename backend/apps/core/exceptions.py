"""Uniform error envelope: {"detail": str, "code": str, "errors": {field: [messages]}}."""
import logging

from django.core.exceptions import PermissionDenied as DjangoPermissionDenied
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError
from django.db.models import ProtectedError
from django.http import Http404
from rest_framework import exceptions, status
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_exception_handler

from .context import request_id_var

logger = logging.getLogger(__name__)


class BusinessRuleError(exceptions.APIException):
    """A request that is well-formed but violates a business rule (closed period, over-allocation...)."""

    status_code = status.HTTP_409_CONFLICT
    default_detail = "The operation is not allowed in the current state."
    default_code = "business_rule"

    def __init__(self, detail=None, code=None, errors=None):
        super().__init__(detail, code)
        self.errors = errors or {}


def _flatten(detail):
    if isinstance(detail, dict):
        return {key: _flatten(value) for key, value in detail.items()}
    if isinstance(detail, list):
        if all(not isinstance(item, (dict, list)) for item in detail):
            return [str(item) for item in detail]
        return [_flatten(item) for item in detail]
    return [str(detail)]


def exception_handler(exc, context):
    if isinstance(exc, DjangoValidationError):
        exc = exceptions.ValidationError(exc.message_dict if hasattr(exc, "message_dict") else exc.messages)
    elif isinstance(exc, Http404):
        exc = exceptions.NotFound()
    elif isinstance(exc, DjangoPermissionDenied):
        exc = exceptions.PermissionDenied()
    elif isinstance(exc, ProtectedError):
        exc = BusinessRuleError("This record is referenced by other records. Deactivate it instead of deleting.", "protected")
    elif isinstance(exc, IntegrityError):
        logger.warning("Integrity error: %s", exc)
        exc = BusinessRuleError("The change conflicts with existing data (duplicate or referenced record).", "integrity")

    response = drf_exception_handler(exc, context)
    if response is None:
        logger.exception("Unhandled error", exc_info=exc)
        return Response(
            {"detail": "An unexpected error occurred.", "code": "server_error", "request_id": request_id_var.get()},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR,
        )

    body = {"code": getattr(exc, "default_code", "error"), "request_id": request_id_var.get()}
    if isinstance(exc, exceptions.ValidationError):
        body["detail"] = "Please correct the highlighted fields."
        body["code"] = "validation_error"
        errors = _flatten(exc.detail)
        body["errors"] = errors if isinstance(errors, dict) else {"non_field_errors": errors}
    else:
        detail = exc.detail if hasattr(exc, "detail") else str(exc)
        body["detail"] = str(detail) if not isinstance(detail, (dict, list)) else "Request failed."
        codes = exc.get_codes() if hasattr(exc, "get_codes") else None
        if isinstance(codes, str):
            body["code"] = codes
        if isinstance(detail, (dict, list)):
            body["errors"] = _flatten(detail)
        if getattr(exc, "errors", None):
            body["errors"] = exc.errors
    response.data = body
    return response
