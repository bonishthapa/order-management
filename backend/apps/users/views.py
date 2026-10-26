import logging
from urllib.parse import urlparse

from django.conf import settings
from django.contrib.auth import authenticate
from django.contrib.auth.password_validation import validate_password
from django.contrib.auth.tokens import default_token_generator
from django.core.mail import send_mail
from django.db import transaction
from django.utils.encoding import force_bytes, force_str
from django.utils.http import urlsafe_base64_decode, urlsafe_base64_encode
from drf_spectacular.utils import extend_schema
from rest_framework import exceptions, mixins, serializers, status, viewsets
from rest_framework.decorators import action, api_view, permission_classes, throttle_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import SimpleRateThrottle
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import RefreshToken

from apps.audit.services import record_event
from apps.core.permissions import HasModulePermission, resolve_membership
from apps.core.viewsets import OrganizationScopedMixin

from .models import Membership, User
from .roles import ALL_PERMISSIONS, ROLE_PERMISSIONS, Role
from .serializers import (
    AdminPasswordResetSerializer,
    ChangePasswordSerializer,
    MemberSerializer,
    MeSerializer,
    PasswordResetConfirmSerializer,
)

logger = logging.getLogger(__name__)


class AuthThrottle(SimpleRateThrottle):
    """Per-IP limit for unauthenticated credential endpoints."""

    scope = "auth"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}


class PasswordResetThrottle(AuthThrottle):
    scope = "password_reset"


def _set_refresh_cookie(response, refresh):
    response.set_cookie(
        settings.REFRESH_COOKIE_NAME, str(refresh),
        max_age=int(settings.SIMPLE_JWT["REFRESH_TOKEN_LIFETIME"].total_seconds()),
        httponly=True, secure=settings.REFRESH_COOKIE_SECURE, samesite=settings.REFRESH_COOKIE_SAMESITE,
        path=settings.REFRESH_COOKIE_PATH,
    )


def _check_origin(request):
    """Cookie-authenticated endpoints only accept same-site or trusted origins (CSRF defence)."""
    origin = request.headers.get("Origin")
    if not origin:
        return
    allowed = {o.rstrip("/") for o in settings.CSRF_TRUSTED_ORIGINS + settings.CORS_ALLOWED_ORIGINS}
    host_origin = f"{request.scheme}://{request.get_host()}"
    if origin.rstrip("/") not in allowed and origin.rstrip("/") != host_origin:
        logger.warning("Rejected auth request from origin %s", urlparse(origin).netloc)
        raise exceptions.PermissionDenied("Origin not allowed.")


def session_payload(user, request):
    request.user = user
    if hasattr(request, "_erp_resolved"):
        del request._erp_resolved
    try:
        resolve_membership(request)
    except exceptions.APIException:
        request.organization = None
        request.perms = set()
    org = request.organization
    return {
        "user": MeSerializer(user).data,
        "organization": None if org is None else {
            "id": org.id, "name": org.name, "code": org.code, "currency": org.currency,
            "currency_symbol": org.currency_symbol, "locale": org.locale, "timezone": org.timezone,
            "date_display_mode": org.date_display_mode, "date_input_calendar": org.date_input_calendar,
            "logo": org.logo.url if org.logo else None,
        },
        "role": getattr(request.membership, "role", Role.SUPER_ADMIN if user.is_superuser else None),
        "permissions": sorted(request.perms),
    }


class LoginSerializer(serializers.Serializer):
    email = serializers.EmailField()
    password = serializers.CharField()


@extend_schema(request=LoginSerializer, tags=["auth"])
@api_view(["POST"])
@permission_classes([AllowAny])
@throttle_classes([AuthThrottle])
def login(request):
    data = LoginSerializer(data=request.data)
    data.is_valid(raise_exception=True)
    user = authenticate(request, email=data.validated_data["email"].lower(), password=data.validated_data["password"])
    if user is None:
        record_event(None, "auth.login_failed", "user", entity_id=data.validated_data["email"].lower()[:40])
        raise exceptions.AuthenticationFailed("Incorrect email or password.")
    refresh = RefreshToken.for_user(user)
    from django.contrib.auth.models import update_last_login

    update_last_login(None, user)
    payload = session_payload(user, request)
    payload["access"] = str(refresh.access_token)
    response = Response(payload)
    _set_refresh_cookie(response, refresh)
    record_event(user, "auth.login", "user", user, organization=getattr(request, "organization", None))
    return response


@extend_schema(request=None, tags=["auth"])
@api_view(["POST"])
@permission_classes([AllowAny])
@throttle_classes([AuthThrottle])
def refresh(request):
    _check_origin(request)
    raw = request.COOKIES.get(settings.REFRESH_COOKIE_NAME)
    if not raw:
        raise exceptions.NotAuthenticated("Session expired. Please sign in again.")
    try:
        token = RefreshToken(raw)
        user = User.objects.get(pk=token["user_id"], is_active=True)
        token.blacklist()
    except (TokenError, User.DoesNotExist, KeyError):
        response = Response({"detail": "Session expired. Please sign in again.", "code": "session_expired"},
                            status=status.HTTP_401_UNAUTHORIZED)
        response.delete_cookie(settings.REFRESH_COOKIE_NAME, path=settings.REFRESH_COOKIE_PATH)
        return response
    new_refresh = RefreshToken.for_user(user)
    payload = session_payload(user, request)
    payload["access"] = str(new_refresh.access_token)
    response = Response(payload)
    _set_refresh_cookie(response, new_refresh)
    return response


@extend_schema(request=None, tags=["auth"])
@api_view(["POST"])
@permission_classes([AllowAny])
def logout(request):
    _check_origin(request)
    raw = request.COOKIES.get(settings.REFRESH_COOKIE_NAME)
    if raw:
        try:
            RefreshToken(raw).blacklist()
        except TokenError:
            pass
    response = Response(status=status.HTTP_204_NO_CONTENT)
    response.delete_cookie(settings.REFRESH_COOKIE_NAME, path=settings.REFRESH_COOKIE_PATH)
    return response


@extend_schema(request=MeSerializer, responses=MeSerializer, tags=["auth"])
@api_view(["GET", "PATCH"])
@permission_classes([IsAuthenticated])
def me(request):
    if request.method == "PATCH":
        serializer = MeSerializer(request.user, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
    return Response(session_payload(request.user, request))


@extend_schema(request=ChangePasswordSerializer, tags=["auth"])
@api_view(["POST"])
@permission_classes([IsAuthenticated])
@throttle_classes([AuthThrottle])
def change_password(request):
    serializer = ChangePasswordSerializer(data=request.data, context={"request": request})
    serializer.is_valid(raise_exception=True)
    user = request.user
    user.set_password(serializer.validated_data["new_password"])
    user.must_change_password = False
    user.save(update_fields=["password", "must_change_password"])
    record_event(user, "auth.password_changed", "user", user)
    return Response(status=status.HTTP_204_NO_CONTENT)


class EmailSerializer(serializers.Serializer):
    email = serializers.EmailField()


@extend_schema(request=EmailSerializer, tags=["auth"])
@api_view(["POST"])
@permission_classes([AllowAny])
@throttle_classes([PasswordResetThrottle])
def password_reset(request):
    serializer = EmailSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    user = User.objects.filter(email__iexact=serializer.validated_data["email"], is_active=True).first()
    if user:
        uid = urlsafe_base64_encode(force_bytes(user.pk))
        token = default_token_generator.make_token(user)
        link = f"{settings.FRONTEND_URL}/reset-password?uid={uid}&token={token}"
        send_mail("Reset your password", f"Use this link to set a new password (valid for 3 days):\n\n{link}\n\n"
                  "If you did not ask for this, you can ignore this email.", settings.DEFAULT_FROM_EMAIL, [user.email])
        record_event(user, "auth.password_reset_requested", "user", user)
    # Same response whether or not the address exists, so accounts cannot be enumerated.
    return Response({"detail": "If the address belongs to an account, a reset link has been sent."})


@extend_schema(request=PasswordResetConfirmSerializer, tags=["auth"])
@api_view(["POST"])
@permission_classes([AllowAny])
@throttle_classes([PasswordResetThrottle])
def password_reset_confirm(request):
    serializer = PasswordResetConfirmSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    try:
        user = User.objects.get(pk=force_str(urlsafe_base64_decode(serializer.validated_data["uid"])), is_active=True)
    except (User.DoesNotExist, ValueError, TypeError):
        raise exceptions.ValidationError({"token": ["The reset link is invalid or has expired."]})
    if not default_token_generator.check_token(user, serializer.validated_data["token"]):
        raise exceptions.ValidationError({"token": ["The reset link is invalid or has expired."]})
    validate_password(serializer.validated_data["new_password"], user)
    user.set_password(serializer.validated_data["new_password"])
    user.must_change_password = False
    user.save()
    record_event(user, "auth.password_reset", "user", user)
    return Response(status=status.HTTP_204_NO_CONTENT)


class MemberViewSet(OrganizationScopedMixin, mixins.ListModelMixin, mixins.RetrieveModelMixin, mixins.CreateModelMixin,
                    mixins.UpdateModelMixin, viewsets.GenericViewSet):
    """Users of the current organisation. Deactivate instead of deleting."""

    queryset = Membership.objects.select_related("user").prefetch_related("branches", "warehouses")
    serializer_class = MemberSerializer
    permission_map = {
        "list": ("users.manage", "audit.view"), "retrieve": ("users.manage", "audit.view"), "create": "users.manage",
        "update": "users.manage", "partial_update": "users.manage", "deactivate": "users.manage",
        "activate": "users.manage", "reset_password": "users.manage", "roles": None,
    }
    search_fields = ["user__email", "user__full_name"]
    filterset_fields = ["role", "is_active"]
    ordering_fields = ["user__full_name", "role", "created_at"]
    ordering = ["user__full_name"]

    def perform_create(self, serializer):
        with transaction.atomic():
            membership = serializer.save()
            record_event(self.request, "user.added", "membership", membership,
                         new={"email": membership.user.email, "role": membership.role})

    def perform_update(self, serializer):
        before = {"role": serializer.instance.role, "is_active": serializer.instance.is_active}
        membership = serializer.save()
        if membership.user_id == self.request.user.id and membership.role != before["role"]:
            raise exceptions.ValidationError({"role": ["You cannot change your own role."]})
        record_event(self.request, "user.updated", "membership", membership, old=before,
                     new={"role": membership.role, "is_active": membership.is_active})

    @action(detail=True, methods=["post"])
    def deactivate(self, request, pk=None):
        membership = self.get_object()
        if membership.user_id == request.user.id:
            raise exceptions.ValidationError("You cannot deactivate yourself.")
        membership.is_active = False
        membership.save(update_fields=["is_active"])
        record_event(request, "user.deactivated", "membership", membership)
        return Response(self.get_serializer(membership).data)

    @action(detail=True, methods=["post"])
    def activate(self, request, pk=None):
        membership = self.get_object()
        membership.is_active = True
        membership.save(update_fields=["is_active"])
        record_event(request, "user.activated", "membership", membership)
        return Response(self.get_serializer(membership).data)

    @extend_schema(request=AdminPasswordResetSerializer)
    @action(detail=True, methods=["post"], url_path="reset-password")
    def reset_password(self, request, pk=None):
        membership = self.get_object()
        serializer = AdminPasswordResetSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = membership.user
        if user.is_superuser and not request.user.is_superuser:
            raise exceptions.PermissionDenied("Only a Super Admin can reset this account.")
        validate_password(serializer.validated_data["new_password"], user)
        user.set_password(serializer.validated_data["new_password"])
        user.must_change_password = True
        user.save()
        record_event(request, "user.password_reset_by_admin", "membership", membership)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=False, methods=["get"])
    def roles(self, request):
        return Response({
            "permissions": [{"code": code, "label": label} for code, label in ALL_PERMISSIONS.items()],
            "roles": [{"code": role.value, "label": role.label, "permissions": sorted(ROLE_PERMISSIONS[role])}
                      for role in Role if role != Role.SUPER_ADMIN],
        })
