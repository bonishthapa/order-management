"""Server-side PDF rendering with WeasyPrint from Django templates in templates/documents/."""
import base64
import mimetypes

from django.http import HttpResponse
from django.template.loader import render_to_string
from django.utils import timezone


def logo_data_uri(organization):
    if not organization or not organization.logo:
        return ""
    try:
        with organization.logo.open("rb") as fh:
            data = fh.read()
    except (FileNotFoundError, ValueError):
        return ""
    mime = mimetypes.guess_type(organization.logo.name)[0] or "image/png"
    return f"data:{mime};base64,{base64.b64encode(data).decode()}"


def date_mode_for(request, organization):
    user = getattr(request, "user", None)
    return (getattr(user, "date_display_mode", "") or organization.date_display_mode) if organization else "AD_BS"


def render_pdf(template_name, context, request=None):
    from weasyprint import HTML

    organization = context.get("organization")
    context = {
        "logo": logo_data_uri(organization),
        "date_mode": date_mode_for(request, organization),
        "generated_at": timezone.localtime(),
        "generated_by": getattr(getattr(request, "user", None), "full_name", ""),
        **context,
    }
    html = render_to_string(template_name, context)
    return HTML(string=html, base_url="/").write_pdf()


def pdf_response(pdf_bytes, filename, inline=True):
    response = HttpResponse(pdf_bytes, content_type="application/pdf")
    disposition = "inline" if inline else "attachment"
    response["Content-Disposition"] = f'{disposition}; filename="{filename}"'
    return response
