# travel_booking/www/traveller/travellers.py
# Traveller management page controller — serves /traveller/travellers
#
# Dua mod:
#   1) Senarai slot (tiada 'res') — user pilih traveller mana untuk diisi
#   2) Individu slot (ada 'res'=slot_name) — passport OCR wizard + form

import frappe
from travel_booking.www.traveller._guard import guard_context, get_query_param


def get_context(context):
    """Prepare context for travellers page."""
    ctx = guard_context(require_customer=True)
    context.update(ctx)

    context.site_name = frappe.get_cached_value(
        "Travel Settings", None, "site_name"
    ) or "Rarecation"
    context.active_nav = 'bookings'
    context.active_tab = 'travellers'

    # Get booking ref from query param
    booking_ref = get_query_param('ref')
    context.booking_ref = booking_ref if booking_ref else None

    # 'res' = slot_name (Booking Reservation name) — bila ada, page masuk
    # mod individu (wizard passport → form). Bila tiada, page jadi senarai
    # pemilihan slot sahaja.
    slot_res = get_query_param('res')
    context.slot_res = slot_res if slot_res else None

    # pageData mesti dict yang boleh JSON-serialize
    context.page_data = {
        "csrf_token": ctx.get("csrf_token", ""),
        "booking_ref": context.booking_ref or "",
        "slot_res": context.slot_res or ""
    }

    return context
