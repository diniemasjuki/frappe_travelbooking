"""Backfill Room ID untuk rekod lama yang kosong.

Room ID (BookingReservation.assign_room_id) = [booking_number] +
"-Room_" + [cabin_no] — diisi automatik pada validate() SEJAK field ni
wujud, tapi reservation yang dicipta SEBELUM patch/deploy itu tidak
terjejas (validate hanya laku masa simpan). Panel portal
(/traveller/travellers) memaparkan Room ID dari rekod ini — rekod lama
yang kosong dipaparkan "NA". Patch ni isi rekod kosong SAHAJA dengan
formula yang sama, supaya paparan portal konsisten tanpa mengubah
Room ID yang admin dah isi manual.

Idempoten — hanya isi nilai kosong; selamat laku berulang.
"""

import frappe


def execute():
    rows = frappe.db.sql("""
        SELECT name, booking, cabin_no
        FROM `tabBooking Reservation`
        WHERE booking IS NOT NULL AND cabin_no IS NOT NULL
          AND (room_id IS NULL OR room_id = '')
        ORDER BY booking ASC, creation ASC
    """, as_dict=True)

    for row in rows:
        # Sumber ref sama dgn assign_room_id(): booking_number pada
        # reservation biasanya fetch_from Booking (tak diisi untuk rekod
        # yang dicipta server-side) → fallback DB Booking, kemudian docname.
        ref = frappe.db.get_value("Booking", row.booking, "booking_number")
        if not ref:
            ref = row.booking
        frappe.db.set_value(
            "Booking Reservation", row.name,
            "room_id", str(ref) + "-Room_" + str(row.cabin_no),
            update_modified=False,
        )
