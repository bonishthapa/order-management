from django.contrib.auth.password_validation import validate_password
from django.db import transaction
from rest_framework import serializers

from apps.inventory.models import Warehouse
from apps.organizations.models import Branch, DateDisplayMode
from apps.core.serializers import OrgRelatedField

from .models import Membership, User
from .roles import Role, permissions_for


class MembershipSummarySerializer(serializers.ModelSerializer):
    organization_name = serializers.CharField(source="organization.name", read_only=True)
    role_label = serializers.CharField(source="get_role_display", read_only=True)

    class Meta:
        model = Membership
        fields = ["organization", "organization_name", "role", "role_label"]


class MeSerializer(serializers.ModelSerializer):
    memberships = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ["id", "email", "full_name", "phone", "date_display_mode", "is_superuser", "must_change_password",
                  "default_organization", "memberships"]
        read_only_fields = ["id", "email", "is_superuser", "must_change_password", "memberships"]

    def get_memberships(self, user):
        qs = user.memberships.filter(is_active=True, organization__is_active=True).select_related("organization")
        return MembershipSummarySerializer(qs, many=True).data

    def validate_default_organization(self, value):
        if value and not self.instance.memberships.filter(organization=value, is_active=True).exists():
            raise serializers.ValidationError("You are not a member of that organisation.")
        return value


class ChangePasswordSerializer(serializers.Serializer):
    current_password = serializers.CharField()
    new_password = serializers.CharField()

    def validate(self, attrs):
        user = self.context["request"].user
        if not user.check_password(attrs["current_password"]):
            raise serializers.ValidationError({"current_password": ["The current password is incorrect."]})
        validate_password(attrs["new_password"], user)
        return attrs


class PasswordResetConfirmSerializer(serializers.Serializer):
    uid = serializers.CharField()
    token = serializers.CharField()
    new_password = serializers.CharField()


class MemberSerializer(serializers.ModelSerializer):
    """A user as seen inside the current organisation (membership + profile)."""

    email = serializers.EmailField(source="user.email")
    full_name = serializers.CharField(source="user.full_name")
    phone = serializers.CharField(source="user.phone", required=False, allow_blank=True)
    user_active = serializers.BooleanField(source="user.is_active", read_only=True)
    last_login = serializers.DateTimeField(source="user.last_login", read_only=True)
    role_label = serializers.CharField(source="get_role_display", read_only=True)
    branches = OrgRelatedField(Branch, many=True, required=False)
    warehouses = OrgRelatedField(Warehouse, many=True, required=False)
    password = serializers.CharField(write_only=True, required=False, allow_blank=True)
    permissions = serializers.SerializerMethodField()

    class Meta:
        model = Membership
        fields = ["id", "user", "email", "full_name", "phone", "role", "role_label", "branches", "warehouses",
                  "is_active", "user_active", "last_login", "password", "permissions", "created_at"]
        read_only_fields = ["id", "user", "created_at"]

    def get_permissions(self, membership):
        return sorted(permissions_for(membership.role))

    def validate_role(self, value):
        if value == Role.SUPER_ADMIN:
            raise serializers.ValidationError("Super Admin is a platform role and cannot be assigned here.")
        return value

    def validate(self, attrs):
        if self.instance is None:
            email = attrs["user"]["email"].lower()
            organization = self.context["organization"]
            if Membership.objects.filter(user__email__iexact=email, organization=organization).exists():
                raise serializers.ValidationError({"email": ["This user already belongs to the organisation."]})
            existing = User.objects.filter(email__iexact=email).first()
            if existing is None:
                if not attrs.get("password"):
                    raise serializers.ValidationError({"password": ["Set an initial password for the new user."]})
                validate_password(attrs["password"])
        return attrs

    @transaction.atomic
    def create(self, validated_data):
        user_data = validated_data.pop("user")
        password = validated_data.pop("password", "")
        branches = validated_data.pop("branches", [])
        warehouses = validated_data.pop("warehouses", [])
        organization = self.context["organization"]
        user = User.objects.filter(email__iexact=user_data["email"]).first()
        if user is None:
            user = User.objects.create_user(
                email=user_data["email"], password=password, full_name=user_data["full_name"],
                phone=user_data.get("phone", ""), default_organization=organization, must_change_password=True,
            )
        membership = Membership.objects.create(user=user, organization=organization, role=validated_data["role"],
                                               is_active=validated_data.get("is_active", True))
        membership.branches.set(branches)
        membership.warehouses.set(warehouses)
        return membership

    @transaction.atomic
    def update(self, membership, validated_data):
        user_data = validated_data.pop("user", {})
        validated_data.pop("password", None)
        branches = validated_data.pop("branches", None)
        warehouses = validated_data.pop("warehouses", None)
        user = membership.user
        for key in ("full_name", "phone"):
            if key in user_data:
                setattr(user, key, user_data[key])
        user.save()
        for key, value in validated_data.items():
            setattr(membership, key, value)
        membership.save()
        if branches is not None:
            membership.branches.set(branches)
        if warehouses is not None:
            membership.warehouses.set(warehouses)
        return membership


class AdminPasswordResetSerializer(serializers.Serializer):
    new_password = serializers.CharField()


__all__ = ["DateDisplayMode"]
