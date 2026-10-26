# travel_booking/www/traveller/onbehalf_addons.py
# On-behalf ADD-ONS page controller — serves /traveller/onbehalf-addons
# (nama fail garis bawah: Frappe cari controller <route dgn '-' diganti '_'>.py
#  — konvensyen sama dengan onbehalf_billing.py / onbehalf_booking.py)
#
# Add-on catalog & cart booking yang manager (affiliate / sales user) buat
# BAGI PIHAK customer lain — pasangan kepada /traveller/booking_addons
# (page pemilik). Berasingan supaya pengurusan kebenaran jelas:
#   - Page ini MENUNTUT role on-behalf (Travel Settings > On-Behalf
#     Booking Roles) — user lain dihantar balik ke senarai masing-masing.
#   - Kebenaran data disaring server-side oleh addon_manager (semua
#     endpoint gate melalui _get_owned_booking → _booking_action_allowed
#     tahap "Docs": milik sendiri ATAU managed booked_by + channel !=
#     Direct); page ini sekadar routing, bukan sekuriti.
#   - pageData membawa mode="onbehalf" — portal_addons.js & template
#     guna back-link ke page onbehalf yang sepadan.

import frappe
from travel_booking.utils.website_config import web_date
from travel_booking.www.traveller._guard import guard_context, get_query_param, require_on_behalf_manager


def get_context(context):
    """Prepare context for on-behalf add-on catalog page."""
    ctx = guard_context(require_customer=True)
    context.update(ctx)

    # Khusus manager on-behalf — customer biasa yang tersasar ke URL ni
    # dibawa balik ke My Bookings. (Routing halaman sahaja; endpoint data
    # tetap menolak akses bukan-manager secara independen.)
    require_on_behalf_manager()

    booking_ref = get_query_param("booking") or get_query_param("ref")
    if not booking_ref:
        frappe.local.flags.redirect_location = "/traveller/onbehalf"
        raise frappe.Redirect

    # Kebenaran + info booking — _get_owned_booking menerima manager
    # on-behalf (tahap Docs) selain pemilik; throw → balik ke senarai.
    try:
        from travel_booking.api.addon_manager import _get_owned_booking
        booking_info = _get_owned_booking(booking_ref)
    except Exception:
        frappe.local.flags.redirect_location = "/traveller/onbehalf"
        raise frappe.Redirect

    # Fetch trip info for display (departure/return dates, sailing, ports, ship)
    trip_info = {}
    try:
        rows = frappe.db.sql("""
            SELECT
                tm.trip_name,
                tm.is_a_cruise_trip AS trip_is_cruise,
                td.trip_group_name, td.departure_date, td.return_date,
                td.sailing_start, td.sailing_end,
                td.ship_name, td.total_nights,
                tp.package_title, tp.package_type,
                tp.airport_form,
                ap.airport_name AS airport_name,
                ep.destination_name AS embark_port_name,
                dp.destination_name AS disembark_port_name
            FROM `tabBooking` b
            LEFT JOIN `tabTrip Group Date`        td ON td.name = b.trip_date
            LEFT JOIN `tabTrip`                    tm ON tm.name = td.trip
            LEFT JOIN `tabTrip Package`           tp ON tp.name = b.trip_package
            LEFT JOIN `tabFlight Airport`         ap ON ap.name = tp.airport_form
            LEFT JOIN `tabTrip Destination Point` ep ON ep.name = td.embarkation_port
            LEFT JOIN `tabTrip Destination Point` dp ON dp.name = td.disembarkation_port
            WHERE b.name = %s
        """, booking_info.name, as_dict=True)
        if rows:
            trip_info = rows[0]
            raw = dict(rows[0])
            for key in ("departure_date", "return_date", "sailing_start", "sailing_end"):
                val = trip_info.get(key)
                if val:
                    trip_info[key] = web_date(val)
            trip_info.update(_header_derived_fields(raw))
    except Exception as e:
        print(f"Warning: Could not load trip info: {e}")

    context.trip_info = trip_info

    # Load travellers (with error handling)
    try:
        travellers = frappe.get_all(
            "Booking Reservation",
            filters={"booking": booking_info.name},
            fields=["name", "traveller_full_name", "guest_label", "pax_type", "document_status"],
            order_by="cabin_no asc, creation asc",
        )
    except Exception:
        travellers = []

    context.site_name = frappe.get_cached_value("Travel Settings", None, "site_name") or "Rarecation"
    context.active_nav = 'onbehalf'
    context.active_tab = 'addons'
    context.booking_ref = booking_ref
    context.booking_info = booking_info
    context.travellers = travellers

    # Preload available addons server-side (avoids separate API call & auth issues)
    # MULTI-COMPANY: currency selector addon — param ?currency= (bebas pilih
    # antara currency yang diisytiharkan; default = currency booking utama).
    available_addons = []
    addon_currency = ""
    addon_currency_symbol = ""
    addon_currency_options = []
    try:
        from travel_booking.api.addon_manager import get_available_addons
        # Use ignore_permissions since we already verified access above
        frappe.flags.ignore_permissions = True
        addons_data = get_available_addons(
            booking_ref, currency=get_query_param("currency") or None
        )
        available_addons = addons_data.get("addons") or []
        addon_currency = addons_data.get("currency") or ""
        addon_currency_symbol = addons_data.get("currency_symbol") or ""
        addon_currency_options = addons_data.get("currency_options") or []
    except Exception as e:
        frappe.log_error(title="onbehalf_addons: load addons failed", message=e)
        available_addons = []

    context.addon_currency = addon_currency
    context.addon_currency_symbol = addon_currency_symbol
    context.addon_currency_options = addon_currency_options
    context.page_data = {
        "csrf_token": ctx.get("csrf_token", ""),
        "booking_ref": booking_ref,
        "travellers": travellers,  # Add travellers to page_data for JS
        "available_addons": available_addons,
        "currency": addon_currency,
        "currency_symbol": addon_currency_symbol,
        "currency_options": addon_currency_options,
        "mode": "onbehalf",
    }

    return context


def _header_derived_fields(raw: dict) -> dict:
    """Medan terbitan untuk header page onbehalf-addons — SALINAan
    _header_derived_fields booking_addons.py (satu corak render yang sama
    dengan page pemilik; rujuk situ untuk semantik penuh)."""
    from datetime import date as _date

    def _fmt(d, with_month=True, with_year=True):
        if not d:
            return ""
        out = "%02d" % d.day
        if with_month:
            out += " " + d.strftime("%b")
        if with_year:
            out += " " + d.strftime("%Y")
        return out

    out = {}

    ss = raw.get("sailing_start")
    se = raw.get("sailing_end")
    if ss and se and isinstance(ss, _date):
        if ss.year == se.year and ss.month == se.month:
            out["sailing_range"] = "%s – %s" % (_fmt(ss, False, False), _fmt(se))
        elif ss.year == se.year:
            out["sailing_range"] = "%s – %s" % (_fmt(ss, True, False), _fmt(se))
        else:
            out["sailing_range"] = "%s – %s" % (_fmt(ss), _fmt(se))

    ep = (raw.get("embark_port_name") or "").strip()
    dp = (raw.get("disembark_port_name") or "").strip()
    if ep and dp:
        out["route_display"] = ep + " (round trip)" if ep == dp else ep + " → " + dp
    elif ep or dp:
        out["route_display"] = ep or dp

    package_type = (raw.get("package_type") or "").strip()
    has_flight = bool(raw.get("airport_name")) or "fly" in package_type.lower()
    dep = raw.get("departure_date")
    ret = raw.get("return_date")
    airport = (raw.get("airport_name") or "").strip()

    if has_flight:
        parts = []
        if dep and ret:
            parts.append("%s → %s" % (web_date(dep), web_date(ret)))
        elif dep:
            parts.append(web_date(dep))
        if airport:
            parts.append(airport)
        out["departure_display"] = " · ".join(parts)
    elif not raw.get("trip_is_cruise"):
        if dep and ret:
            out["departure_display"] = "%s → %s" % (web_date(dep), web_date(ret))
    else:
        out["departure_display"] = ""

    return out
