"""Backfill flight Booking → slot Booking Reservation (fill-empty-only).

Field flight pada doctype Booking DIBUANG dalam rilis ni (flight jadi milik
Booking Reservation sepenuhnya — satu slot satu flight, group boleh berpecah
flight). Sebelum field tu hilang dari form, flight yang admin dah set di
level Booking mesti diwariskan dulu ke slot-slot yang masih kosong — kalau
tidak, booking yang flight-nya diisi SELEPAS slot dicipta (fetch_if_empty
hanya laku masa slot disimpan) akan hilang maklumat flight terus.

Patch ni didaftar di pre_model_sync — laku SEBELUM doctype JSON disinkron,
jadi kolum `flight` pada tabBooking masih wujud & aktif masa SQL jalan.

Idempoten — hanya isi slot kosong; selamat laku berulang.
"""

import frappe


def execute():
    # Booking yang ada flight + slot kosongnya — satu query grouped, cukup
    # untuk semua booking sekaligus (tiada loop per-booking ke DB).
    rows = frappe.db.sql("""
        SELECT b.name AS booking, b.flight,
               GROUP_CONCAT(r.name) AS empty_slots
        FROM `tabBooking` b
        JOIN `tabBooking Reservation` r
             ON r.booking = b.name
            AND (r.flight IS NULL OR r.flight = '')
        WHERE b.flight IS NOT NULL AND b.flight != ''
        GROUP BY b.name, b.flight
    """, as_dict=True)

    updated = 0
    for row in rows:
        updated += frappe.db.sql("""
            UPDATE `tabBooking Reservation`
            SET flight = %(flight)s
            WHERE booking = %(booking)s
              AND (flight IS NULL OR flight = '')
        """, {"booking": row.booking, "flight": row.flight})[0] or 0

    if rows:
        frappe.logger("travel_booking").info(
            "v24_flight_to_reservation_slots_backfill: %s booking diproses, "
            "%s slot reservation diisi flight." % (len(rows), updated)
        )
