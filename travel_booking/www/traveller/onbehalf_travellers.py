# travel_booking/www/traveller/onbehalf_travellers.py
# On-behalf TRAVELLERS page controller — serves /traveller/onbehalf-travellers
# (nama fail garis bawah: Frappe cari controller <route dgn '-' diganti '_'>.py
#  — konvensyen sama dengan onbehalf_billing.py / onbehalf_booking.py)
#
# Traveller & dokumen booking yang manager (affiliate / sales user) buat
# BAGI PIHAK customer lain — pasangan kepada /traveller/travellers (page
# pemilik). Berasingan supaya pengurusan kebenaran jelas:
#   - Page ini MENUNTUT role on-behalf (Travel Settings > On-Behalf
#     Booking Roles) — user lain dihantar balik ke senarai masing-masing.
#   - Data disaring server-side oleh API yang sama dengan page pemilik
#     (get_booking_data / save_booking_traveller / cabin_sharing — semua
#     mengenali set managed booked_by + channel != Direct, gate tindakan
#     ikut TAHAP AKSES "Docs"); page ini sekadar routing, bukan sekuriti.
#   - pageData membawa mode="onbehalf" — traveller_travellers.js guna
#     route/back-link yang betul dan papar mod manager.

import frappe
from travel_booking.www.traveller._guard import guard_context, get_query_param, require_on_behalf_manager


def get_context(context):
    """Prepare context for on-behalf travellers page."""
    ctx = guard_context(require_customer=True)
    context.update(ctx)

    # Khusus manager on-behalf — customer biasa yang tersasar ke URL ni
    # dibawa balik ke My Bookings. (Routing halaman sahaja; endpoint data
    # tetap menolak akses bukan-manager secara independen.)
    require_on_behalf_manager()

    context.site_name = frappe.get_cached_value(
        "Travel Settings", None, "site_name"
    ) or "Rarecation"
    context.active_nav = 'onbehalf'
    context.active_tab = 'travellers'

    # Query params — sama dengan page pemilik (/traveller/travellers):
    #   ref = booking_number, res = slot_name (mod individu borang traveller)
    booking_ref = get_query_param('ref')
    context.booking_ref = booking_ref if booking_ref else None
    slot_res = get_query_param('res')
    context.slot_res = slot_res if slot_res else None

    # Badge enjin scan passport (AI vs OCR) — sama sumber dengan page pemilik.
    try:
        from travel_booking.api.receipt_ocr import _get_settings
        ai_scan_enabled = bool(_get_settings().get("enabled"))
    except Exception:
        ai_scan_enabled = False

    # pageData mesti dict yang boleh JSON-serialize
    context.page_data = {
        "csrf_token": ctx.get("csrf_token", ""),
        "booking_ref": context.booking_ref or "",
        "slot_res": context.slot_res or "",
        "ai_scan_enabled": ai_scan_enabled,
        "mode": "onbehalf",
    }

    return context
