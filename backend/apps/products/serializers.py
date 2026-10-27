from django.db import transaction
from rest_framework import serializers

from apps.core.numbering import next_code
from apps.core.serializers import BaseModelSerializer, OrgRelatedField
from apps.customers.models import CustomerCategory
from apps.organizations.models import TaxRate, UnitOfMeasure

from .models import Brand, PriceTier, Product, ProductCategory


class ProductCategorySerializer(BaseModelSerializer):
    parent = OrgRelatedField(ProductCategory, required=False, allow_null=True)
    product_count = serializers.IntegerField(read_only=True, default=None)

    class Meta:
        model = ProductCategory
        fields = ["id", "name", "parent", "is_active", "product_count"]


class BrandSerializer(BaseModelSerializer):
    product_count = serializers.IntegerField(read_only=True, default=None)

    class Meta:
        model = Brand
        fields = ["id", "name", "is_active", "product_count"]


class PriceTierSerializer(serializers.ModelSerializer):
    id = serializers.IntegerField(required=False)
    customer_category = OrgRelatedField(CustomerCategory, required=False, allow_null=True)

    class Meta:
        model = PriceTier
        fields = ["id", "customer_category", "min_quantity", "price"]


class ProductSerializer(BaseModelSerializer):
    category = OrgRelatedField(ProductCategory, required=False, allow_null=True)
    brand = OrgRelatedField(Brand, required=False, allow_null=True)
    unit = OrgRelatedField(UnitOfMeasure)
    tax_rate = OrgRelatedField(TaxRate, required=False, allow_null=True)
    variant_of = OrgRelatedField(Product, required=False, allow_null=True)
    category_name = serializers.CharField(source="category.name", read_only=True, default=None)
    brand_name = serializers.CharField(source="brand.name", read_only=True, default=None)
    unit_code = serializers.CharField(source="unit.code", read_only=True)
    tax_rate_percent = serializers.DecimalField(source="tax_rate.rate", max_digits=7, decimal_places=4, read_only=True, default=None)
    price_tiers = PriceTierSerializer(many=True, required=False)
    on_hand = serializers.DecimalField(max_digits=16, decimal_places=3, read_only=True, default=None)
    reserved = serializers.DecimalField(max_digits=16, decimal_places=3, read_only=True, default=None)
    stock_value = serializers.DecimalField(max_digits=18, decimal_places=2, read_only=True, default=None)
    has_transactions = serializers.SerializerMethodField()

    class Meta:
        model = Product
        fields = [
            "id", "sku", "barcode", "name", "description", "product_type", "category", "category_name", "brand",
            "brand_name", "unit", "unit_code", "purchase_price", "selling_price", "tax_rate", "tax_rate_percent",
            "reorder_level", "reorder_quantity", "image", "track_batches", "track_serials", "track_expiry", "variant_of",
            "variant_attributes", "is_active", "price_tiers", "on_hand", "reserved", "stock_value", "has_transactions",
            "created_at", "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]
        extra_kwargs = {"sku": {"required": False, "allow_blank": True}}

    def get_has_transactions(self, obj):
        return obj.ledger_entries.exists() if self.context.get("view") and self.context["view"].action == "retrieve" else None

    def validate_sku(self, value):
        value = (value or "").strip().upper()
        if value:
            qs = Product.objects.filter(organization=self.organization, sku=value)
            if self.instance:
                qs = qs.exclude(pk=self.instance.pk)
            if qs.exists():
                raise serializers.ValidationError("Another product already uses this SKU.")
        return value

    def validate_barcode(self, value):
        value = (value or "").strip()
        if value:
            qs = Product.objects.filter(organization=self.organization, barcode=value)
            if self.instance:
                qs = qs.exclude(pk=self.instance.pk)
            if qs.exists():
                raise serializers.ValidationError("Another product already uses this barcode.")
        return value

    def validate_image(self, value):
        if value and value.size > 2 * 1024 * 1024:
            raise serializers.ValidationError("Images must be smaller than 2 MB.")
        return value

    def validate(self, attrs):
        attrs = super().validate(attrs)
        product_type = attrs.get("product_type", getattr(self.instance, "product_type", "STOCK"))
        if product_type == "SERVICE":
            attrs["track_batches"] = attrs["track_serials"] = attrs["track_expiry"] = False
        if self.instance and self.instance.ledger_entries.exists():
            for field in ("product_type", "track_batches", "track_serials", "unit"):
                if field in attrs and attrs[field] != getattr(self.instance, field):
                    raise serializers.ValidationError({field: ["Cannot be changed after stock has been posted."]})
        if attrs.get("track_expiry") and not attrs.get("track_batches", getattr(self.instance, "track_batches", False)):
            raise serializers.ValidationError({"track_expiry": ["Expiry tracking requires batch tracking."]})
        tiers = attrs.get("price_tiers") or []
        seen = set()
        for tier in tiers:
            key = (getattr(tier.get("customer_category"), "pk", None), tier["min_quantity"])
            if key in seen:
                raise serializers.ValidationError({"price_tiers": ["Duplicate minimum quantity for the same customer category."]})
            seen.add(key)
        return attrs

    def _save_tiers(self, product, tiers):
        if tiers is None:
            return
        product.price_tiers.all().delete()
        PriceTier.objects.bulk_create(
            PriceTier(product=product, customer_category=t.get("customer_category"), min_quantity=t["min_quantity"], price=t["price"])
            for t in tiers
        )

    @transaction.atomic
    def create(self, validated_data):
        tiers = validated_data.pop("price_tiers", None)
        if not validated_data.get("sku"):
            validated_data["sku"] = next_code(validated_data["organization"], "product", "ITM")
        product = super().create(validated_data)
        self._save_tiers(product, tiers)
        return product

    @transaction.atomic
    def update(self, instance, validated_data):
        tiers = validated_data.pop("price_tiers", None)
        product = super().update(instance, validated_data)
        self._save_tiers(product, tiers)
        return product


class BulkPriceUpdateSerializer(serializers.Serializer):
    product_ids = serializers.ListField(child=serializers.IntegerField(), required=False)
    category = serializers.IntegerField(required=False)
    field = serializers.ChoiceField(choices=["selling_price", "purchase_price"])
    mode = serializers.ChoiceField(choices=["percent", "amount", "set"])
    value = serializers.DecimalField(max_digits=18, decimal_places=4)
    reason = serializers.CharField(max_length=500)
