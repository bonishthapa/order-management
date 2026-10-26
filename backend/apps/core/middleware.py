import re
import uuid

from .context import request_id_var, request_ip_var

_SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


class RequestIDMiddleware:
    """Accepts a well-formed X-Request-ID from the proxy or generates one, and echoes it back."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        incoming = request.headers.get("X-Request-ID", "")
        request_id = incoming if _SAFE_ID.match(incoming) else uuid.uuid4().hex
        request.request_id = request_id
        id_token = request_id_var.set(request_id)
        forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "")
        ip_token = request_ip_var.set(forwarded.split(",")[0].strip() or request.META.get("REMOTE_ADDR"))
        try:
            response = self.get_response(request)
        finally:
            request_id_var.reset(id_token)
            request_ip_var.reset(ip_token)
        response["X-Request-ID"] = request_id
        return response
