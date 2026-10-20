"""Pindah stamp Booking Reservation.sales_order (design lama v15) ke
junction Share Slot Reservation (design baharu — field pada Booking
Reservation dibuang dari doctype JSON).

Didaftarkan di bawah [pre_model_sync] sengaja: kolum lama masih wujud
masa patch ni jalan — model sync selepasnya yang membuang kolum tu
(sebab field dah tiada dalam doctype JSON). Kalau dijadikan
post_model_sync, data stamp akan hilang sebelum patch sempat membaca.

Idempoten — selamat dijalankan berulang; pasangan yang sudah dipaut
dilangkau. Pada site baharu (kolum lama langsung tak wujud) patch ni
no-op.
"""

import frappe


def execute():
    if not frappe.db.has_column("Booking Reservation", "sales_order"):
        return  # site baharu / kolum dah dibuang — tiada apa nak dipindah

    rows = frappe.db.sql("""
        SELECT br.name AS reservation, br.sales_order AS so_name,
               br.booking AS booking
        FROM `tabBooking Reservation` br
        WHERE IFNULL(br.sales_order, '') != ''
    """, as_dict=True)
    if not rows:
        return

    # Junction table biasanya dicipta oleh model sync SELEPAS patch
    # pre_model_sync ni — cipta awal supaya data tak hilang. reload_doc
    # idempoten: kalau doctype dah wujud, ia sekadar sync semula.
    if not frappe.db.table_exists("Share Slot Reservation"):
        frappe.reload_doc("module_travel_booking", "doctype",
                          "share_slot_reservation")

    linked = set(frappe.get_all("Share Slot Reservation",
                                pluck="booking_reservation"))
    for row in rows:
        if row.reservation in linked:
            continue
        frappe.get_doc({
            "doctype":             "Share Slot Reservation",
            "sales_order":         row.so_name,
            "booking_reservation": row.reservation,
            "booking":             row.booking,
        }).insert(ignore_permissions=True)
