# travel_booking/www/traveller/booking_detail.py
# Booking detail page controller — serves /traveller/booking

import frappe
from travel_booking.www.traveller._guard import guard_context, get_query_param


def get_context(context):
    """Prepare context for booking detail page."""
    ctx = guard_context(require_customer=True)
    context.update(ctx)

    context.site_name = frappe.get_cached_value(
        "Travel Settings", None, "site_name"
    ) or "Rarecation"
    context.active_nav = 'bookings'
    context.active_tab = 'info'

    # Get booking ref from query param
    booking_ref = get_query_param('ref')
    context.booking_ref = booking_ref if booking_ref else None

    # pageData mesti dict yang boleh JSON-serialize
    context.page_data = {
        "csrf_token": ctx.get("csrf_token", ""),
        "booking_ref": context.booking_ref or ""
    }

    return context
