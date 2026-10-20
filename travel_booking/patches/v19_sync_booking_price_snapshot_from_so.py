"""Resync snapshot harga booking dari Sales Order sedia ada.

Sebelum ini pre_discount_total (dan payment_status/prog_payment) hanya
dikira SEKALI semasa booking dicipta — admin yang edit SO terus di Desk
(ubah pax/rate, tambah item, cancel) meninggalkan snapshot booking stale
(punca: booking RIUQRXL2610 — SO diedit 2 pax → 1 pax tapi Pre-Discount
Total kekal RM29,300 sedangkan SO dah RM14,650).

Kini sync berlaku automatik melalui hook Sales Order
(travel_booking.api.booking_engine.on_sales_order_change — rujuk
hooks.py doc_events). Patch ni selaraskan SEMUA booking sedia ada dengan
SO masing-masing sekali supaya data lama turut betul.

Guna _recompute_booking_status() yang sama dengan hook runtime — bukan
SQL terus — supaya semantik (gross = grand_total + additional discount
per SO, exclude SO cancelled) identik dengan apa yang akan berlaku pada
edit SO seterusnya. Idempoten — selamat dijalankan berulang.
"""

import frappe

from travel_booking.api.booking_engine import _recompute_booking_status


def execute():
    # Semua SO tak-cancelled yang dipaut ke booking — set booking unik.
    booking_names = frappe.get_all(
        "Sales Order",
        filters={"custom_booking": ["is", "set"], "docstatus": ["!=", 2]},
        pluck="custom_booking",
        distinct=True,
    )
    for booking_name in booking_names:
        for so_name in frappe.get_all(
            "Sales Order",
            filters={"custom_booking": booking_name, "docstatus": ["!=", 2]},
            pluck="name",
        ):
            try:
                # fire_flows=False — tulis snapshot sahaja, JANGAN hantar
                # email status / cipta reservation / invois semasa migration
                # (aliran tu kekal tanggungjawab hook runtime).
                _recompute_booking_status(so_name, fire_flows=False)
            except Exception:
                frappe.log_error(
                    "Resync snapshot booking " + str(booking_name) +
                    " dari SO " + str(so_name) + " gagal.",
                    "Booking Snapshot Resync Error"
                )
    frappe.db.commit()
