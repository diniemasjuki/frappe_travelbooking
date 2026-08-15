# travel_booking/www/traveller_portal/booking_info.py
# /traveller_portal/booking_info?ref=<booking_number> — ringkasan booking.
#
# NOTA NAMA FAIL: MESTI underscore (booking_info), BUKAN hyphen
# (booking-info) — Frappe muat controller .py melalui import module
# Python, dan nama ber-hyphen membuat import gagal SENYAP:
# get_context() tak pernah dipanggil, context kosong, dan Jinja
# menerima DebugUndefined untuk semua variable (punca asal error
# "booking reference missing" + TypeError tojson).

from travel_booking.www.traveller_portal._guard import get_query_param, guard_context

no_cache = 1


def get_context(context):
    ctx = guard_context()
    context.update(ctx)
    context.active_nav = "bookings"
    context.sub_active = "info"
    context.booking_ref = get_query_param("ref")
