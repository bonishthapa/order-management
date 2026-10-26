"""Organisation resolution and permission checks.

Every organisation-scoped request carries ``X-Organization-ID``. The header is validated
against the user's active memberships; a request for an organisation the user does not
belong to is rejected outright (403), so modified ids in URLs, bodies or filters cannot
reach another organisation's data. Querysets are additionally filtered by organisation.
"""
from rest_framework import exceptions, permissions

from apps.users.roles import Role, permissions_for


def resolve_membership(request):
    """Attach ``request.organization``, ``request.membership`` and ``request.perms``."""
    if hasattr(request, "_erp_resolved"):
        return
    request._erp_resolved = True
    request.organization = None
    request.membership = None
    request.perms = set()
    user = request.user
    if not user or not user.is_authenticated:
        return
    from apps.organizations.models import Organization
    from apps.users.models import Membership

    raw = request.headers.get("X-Organization-ID") or (user.default_organization_id and str(user.default_organization_id))
    memberships = Membership.objects.filter(user=user, is_active=True, organization__is_active=True)
    if raw:
        try:
            org_id = int(raw)
        except ValueError:
            raise exceptions.ValidationError({"organization": "Invalid organisation id."})
        membership = memberships.filter(organization_id=org_id).select_related("organization").first()
        if membership is None and user.is_superuser:
            org = Organization.objects.filter(pk=org_id).first()
            if org is None:
                raise exceptions.PermissionDenied("You do not have access to this organisation.")
            request.organization = org
            request.perms = permissions_for(Role.SUPER_ADMIN)
            return
        if membership is None:
            raise exceptions.PermissionDenied("You do not have access to this organisation.")
    else:
        membership = memberships.select_related("organization").order_by("id").first()
        if membership is None:
            return
    request.organization = membership.organization
    request.membership = membership
    request.perms = permissions_for(Role.SUPER_ADMIN if user.is_superuser else membership.role)


class IsOrganizationMember(permissions.BasePermission):
    message = "Select an organisation you belong to."

    def has_permission(self, request, view):
        if not request.user or not request.user.is_authenticated:
            return False
        resolve_membership(request)
        return request.organization is not None


class HasModulePermission(IsOrganizationMember):
    """Checks ``view.permission_map[action]`` or derives ``<module>.view`` / ``<module>.manage``.

    ``permission_map`` values may be a string or a tuple (any one grants access).
    A value of ``None`` means "any member".
    """

    def has_permission(self, request, view):
        if not super().has_permission(request, view):
            return False
        required = required_permission(request, view)
        if required is None:
            return True
        options = (required,) if isinstance(required, str) else tuple(required)
        if any(option in request.perms for option in options):
            return True
        self.message = f"Your role does not allow this action ({options[0]})."
        return False


def required_permission(request, view):
    action = getattr(view, "action", None) or request.method.lower()
    mapping = getattr(view, "permission_map", {}) or {}
    if action in mapping:
        return mapping[action]
    module = getattr(view, "permission_module", None)
    if module is None:
        return None
    if request.method in permissions.SAFE_METHODS:
        return f"{module}.view"
    return f"{module}.manage"


def require(request, perm):
    if perm not in request.perms:
        raise exceptions.PermissionDenied(f"Your role does not allow this action ({perm}).")


def allowed_warehouse_ids(request):
    """Return the warehouse ids a member is restricted to, or None for unrestricted."""
    membership = getattr(request, "membership", None)
    if membership is None:
        return None
    ids = list(membership.warehouses.values_list("id", flat=True))
    return ids or None


def check_warehouse_access(request, warehouse):
    ids = allowed_warehouse_ids(request)
    if ids is not None and warehouse is not None and warehouse.id not in ids:
        raise exceptions.PermissionDenied(f"You do not have access to warehouse {warehouse}.")
