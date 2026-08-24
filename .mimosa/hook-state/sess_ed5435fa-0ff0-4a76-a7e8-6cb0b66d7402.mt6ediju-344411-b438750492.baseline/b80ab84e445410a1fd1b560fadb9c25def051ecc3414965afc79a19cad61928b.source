# travel_booking/www/traveller_portal/transactions.py
# /traveller_portal/transactions — senarai semua transaksi + payment-result.

from travel_booking.www.traveller_portal._guard import guard_context

no_cache = 1


def get_context(context):
    ctx = guard_context()
    context.update(ctx)
    context.active_nav = "transactions"
