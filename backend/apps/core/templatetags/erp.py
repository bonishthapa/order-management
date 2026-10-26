from django import template

from apps.core.formatting import amount_in_words, format_amount, format_date, format_quantity

register = template.Library()


@register.simple_tag(takes_context=True)
def amount(context, value, places=2):
    return format_amount(value, context.get("organization"), places)


@register.filter
def qty(value):
    return format_quantity(value)


@register.simple_tag(takes_context=True)
def bizdate(context, value):
    return format_date(value, context.get("date_mode", "AD_BS"))


@register.filter
def words(value):
    return amount_in_words(value)
