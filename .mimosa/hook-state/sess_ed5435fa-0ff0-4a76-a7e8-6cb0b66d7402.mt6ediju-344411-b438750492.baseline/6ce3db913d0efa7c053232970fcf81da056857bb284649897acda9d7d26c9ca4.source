# travel_booking/www/traveller/transactions.py
# Transactions history page controller — serves /traveller/transactions

import frappe
from travel_booking.www.traveller._guard import guard_context


def get_context(context):
    """Prepare context for transactions page."""
    ctx = guard_context(require_customer=True)
    context.update(ctx)

    context.site_name = frappe.get_cached_value(
        "Travel Settings", None, "site_name"
    ) or "Rarecation"
    context.active_nav = 'transactions'
    context.booking_ref = None
    context.active_tab = None

    # pageData mesti dict yang boleh JSON-serialize
    context.page_data = {
        "csrf_token": ctx.get("csrf_token", ""),
        "booking_ref": ""
    }

    return context
