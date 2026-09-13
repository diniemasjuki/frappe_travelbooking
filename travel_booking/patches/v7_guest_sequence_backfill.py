"""Backfill Guest Sequence + privacy cabin yang pernah tambah traveller.

1. Guest Sequence (urutan tetamu DALAM cabin — rujuk
   BookingReservation.set_guest_sequence): isi untuk rekod sedia ada
   yang masih kosong, dinomborkan 1..N ikut (booking, cabin_no) atas
   turutan creation; slot Cancelled dilangkau.
2. Room privacy → "Private" untuk SEMUA penghuni cabin yang pernah
   menerima traveller tambahan (penanda lama: guest_label
   "Additional Traveller" — label kini seragam "Traveller N", slot
   baharu diproses langsung oleh cabin_sharing._activate_share_traveller_
   reservation tanpa patch ni).

Idempoten — hanya isi nilai kosong / tukar nilai yang masih bukan
"Private" pada cabin sasaran.
"""

import frappe


def execute():
    # ── 1. Backfill Guest Sequence ──────────────────────────────────────
    rows = frappe.db.sql("""
        SELECT name, booking, cabin_no
        FROM `tabBooking Reservation`
        WHERE booking IS NOT NULL AND cabin_no IS NOT NULL
          AND IFNULL(status, '') != 'Cancelled'
        ORDER BY booking ASC, cabin_no ASC, creation ASC
    """, as_dict=True)

    counters = {}
    for row in rows:
        key = (row.booking, row.cabin_no)
        counters[key] = counters.get(key, 0) + 1
        sequence = frappe.db.get_value("Booking Reservation", row.name, "guest_sequence")
        if not sequence:
            frappe.db.set_value("Booking Reservation", row.name,
                                "guest_sequence", counters[key],
                                update_modified=False)

    # ── 2. Privacy cabin yang pernah tambah traveller ───────────────────
    cabins = frappe.db.sql("""
        SELECT DISTINCT booking, cabin_no
        FROM `tabBooking Reservation`
        WHERE guest_label = 'Additional Traveller'
          AND IFNULL(status, '') != 'Cancelled'
    """, as_dict=True)
    for cabin in cabins:
        frappe.db.set_value(
            "Booking Reservation",
            {"booking": cabin.booking, "cabin_no": cabin.cabin_no,
             "status": ["!=", "Cancelled"]},
            "room_privacy", "Private", update_modified=False)
