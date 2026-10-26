"""Serializer support for the AD/BS date contract.

Every business date is stored as a Gregorian ``DateField``. On output the API returns both
``<field>`` (canonical AD, ISO 8601) and ``<field>_bs`` (calculated BS, ``YYYY-MM-DD``).
On input a client may send either ``<field>`` or ``<field>_bs``; a BS value is validated and
converted to AD on the server. Sending both is accepted only when they denote the same day.
"""
import datetime as dt

from django.db import models
from rest_framework import serializers

from .bs import BSDateError, ad_to_bs, parse_bs


def bs_or_none(value):
    if not value:
        return None
    if isinstance(value, str):
        value = dt.date.fromisoformat(value)
    if isinstance(value, dt.datetime):
        raise TypeError("BS representation is only defined for date-only values")
    try:
        return ad_to_bs(value).isoformat()
    except BSDateError:
        return None


def parse_date_input(ad_value=None, bs_value=None, field_name="date"):
    """Return the canonical AD date from an AD and/or BS input, raising ValidationError."""
    ad_date = None
    if ad_value not in (None, ""):
        if isinstance(ad_value, dt.date):
            ad_date = ad_value
        else:
            try:
                ad_date = dt.date.fromisoformat(str(ad_value))
            except ValueError:
                raise serializers.ValidationError({field_name: "Enter a valid AD date in YYYY-MM-DD format."})
    if bs_value not in (None, ""):
        try:
            from_bs = parse_bs(str(bs_value)).to_ad()
        except BSDateError as exc:
            raise serializers.ValidationError({f"{field_name}_bs": str(exc)})
        if ad_date and ad_date != from_bs:
            raise serializers.ValidationError(
                {field_name: f"AD date {ad_date} and BS date {bs_value} refer to different days."}
            )
        ad_date = from_bs
    if ad_date is not None:
        try:
            ad_to_bs(ad_date)
        except BSDateError as exc:
            raise serializers.ValidationError({field_name: str(exc)})
    return ad_date


class DualDateSerializerMixin:
    """Adds ``<name>_bs`` output and BS input support for every model DateField on the serializer."""

    def _dual_date_fields(self):
        names = []
        model = getattr(getattr(self, "Meta", None), "model", None)
        for name, field in self.fields.items():
            if not isinstance(field, serializers.DateField):
                continue
            source = field.source or name
            if model is not None:
                try:
                    model_field = model._meta.get_field(source)
                except Exception:
                    model_field = None
                if model_field is not None and not isinstance(model_field, models.DateField):
                    continue
                if isinstance(model_field, models.DateTimeField):
                    continue
            names.append(name)
        return names

    def to_internal_value(self, data):
        if hasattr(data, "copy"):
            data = data.copy()
        for name in self._dual_date_fields():
            bs_key = f"{name}_bs"
            if bs_key in data and data.get(bs_key) not in (None, ""):
                canonical = parse_date_input(data.get(name), data.get(bs_key), name)
                data[name] = canonical.isoformat()
            if bs_key in data:
                data.pop(bs_key)
        return super().to_internal_value(data)

    def to_representation(self, instance):
        result = super().to_representation(instance)
        for name in self._dual_date_fields():
            if name in result:
                result[f"{name}_bs"] = bs_or_none(result[name])
        return result


class BSDateField(serializers.Field):
    """Read-only helper that renders a date attribute as a BS string."""

    def __init__(self, **kwargs):
        kwargs["read_only"] = True
        super().__init__(**kwargs)

    def to_representation(self, value):
        return bs_or_none(value)
