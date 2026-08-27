# travel_booking/www/traveller/manage_addon.py
# Manage Add-on page — serves /traveller/manage_addon?ref=###
# Lists purchased Booking Addon Items with grouping options.

import frappe
from travel_booking.www.traveller._guard import guard_context, get_query_param


def get_context(context):
    """Prepare context for Manage Add-on page."""
    ctx = guard_context(require_customer=True)
    context.update(ctx)

    booking_ref = get_query_param("ref")
    if not booking_ref:
        frappe.local.flags.redirect_location = "/traveller/bookings"
        raise frappe.Redirect

    # Verify ownership & get booking info
    try:
        from travel_booking.api.addon_manager import _get_owned_booking
        booking_info = _get_owned_booking(booking_ref)
    except Exception:
        frappe.local.flags.redirect_location = "/traveller/bookings"
        raise frappe.Redirect

    # Load travellers (for grouping-by-traveller view)
    try:
        travellers = frappe.get_all(
            "Booking Reservation",
            filters={"booking": booking_info.name},
            fields=["name", "traveller_full_name", "guest_label", "pax_type"],
            order_by="cabin_no asc, creation asc",
        )
    except Exception:
        travellers = []

    # Preload addon orders server-side (avoids separate API call + auth issues)
    addon_orders = []
    try:
        from travel_booking.api.addon_manager import get_booking_addons
        frappe.flags.ignore_permissions = True
        addon_orders = get_booking_addons(booking_ref)
    except Exception as e:
        frappe.log_error(
            "manage_addon: could not load booking addons for ref='%s': %s" % (booking_ref, e),
            frappe.get_traceback()
        )
        addon_orders = []

    context.site_name = frappe.get_cached_value("Travel Settings", None, "site_name") or "Rarecation"
    context.active_nav = "bookings"
    context.booking_ref = booking_ref
    context.booking_info = booking_info
    context.travellers = travellers
    context.addon_orders = addon_orders

    # Jinja's |tojson filter uses json.dumps without a custom default
    # handler, so datetime/date/Decimal objects from frappe.get_all must
    # be converted to native types before going into page_data.
    from decimal import Decimal
    import datetime as _dt

    def _jsonable(val):
        if isinstance(val, (_dt.datetime, _dt.date)):
            return val.isoformat()
        if isinstance(val, Decimal):
            return float(val)
        return val

    for o in addon_orders:
        for k in list(o.keys()):
            o[k] = _jsonable(o.get(k))
        for l in o.get("lines", []):
            for k in list(l.keys()):
                l[k] = _jsonable(l.get(k))

    context.page_data = {
        "csrf_token": ctx.get("csrf_token", ""),
        "booking_ref": booking_ref,
        "addon_orders": addon_orders,
        "travellers": travellers,
    }

    return context
