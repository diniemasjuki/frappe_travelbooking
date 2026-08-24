# travel_booking/www/traveller_portal/booking_billing.py
# /traveller_portal/booking_billing?ref=<booking_number> — SO, transaksi, download, bayar.
#
# NOTA NAMA FAIL: MESTI underscore (booking_billing), BUKAN hyphen —
# nama ber-hyphen gagal di-import sebagai module Python secara senyap,
# jadi get_context() tak pernah jalan (rujuk nota booking_info.py).

from travel_booking.www.traveller_portal._guard import get_query_param, guard_context

no_cache = 1


def get_context(context):
    ctx = guard_context()
    context.update(ctx)
    context.active_nav = "bookings"
    context.sub_active = "billing"
    context.booking_ref = get_query_param("ref")
