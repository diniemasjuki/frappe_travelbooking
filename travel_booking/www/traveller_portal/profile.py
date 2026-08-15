# travel_booking/www/traveller_portal/profile.py
# /traveller_portal/profile — maklumat akaun, phone, password, PDPA rights.

from travel_booking.www.traveller_portal._guard import guard_context

no_cache = 1


def get_context(context):
    ctx = guard_context()
    context.update(ctx)
    context.active_nav = "profile"
