"""Resync Booking.booked_pax dari Sales Order sedia ada.

`booked_pax` sebelum ini hanya ditulis SEKALI semasa booking dicipta
(confirm_booking — snapshot pilihan wizard). Edit pax pada SO terus di
Desk (draft mahupun update-after-submit) tidak pernah disegerak balik —
sedangkan order_summary/total (virtual, kira live dari SO) terus betul,
memberi ilusi dah sync. Kes sebenar: BK2610078 — SO ditambah pax 4 → 6
tapi booked_pax kekal 4, menyebabkan gate overbooking (SUM(booked_pax)
per trip date) dan seat count trip catalog undercount.

Kini booked_pax disegerak automatik oleh _recompute_booking_status()
melalui hook Sales Order (rujuk hooks.py doc_events). Patch ni
selaraskan SEMUA booking sedia ada dengan SO masing-masing sekali.

Guna _recompute_booking_status() yang sama dengan hook runtime — bukan
SQL terus — supaya semantik (SUM qty baris TRAVEL-PKG pada SO aktif,
exclude SO cancelled) identik dengan apa yang akan berlaku pada edit
SO seterusnya. Idempoten — selamat dijalankan berulang.
"""

import frappe

from travel_booking.api.booking_engine import _recompute_booking_status


def execute():
    # Semua SO tak-cancelled yang dipaut ke booking — set booking unik.
    # Booking tanpa SO aktif (cth Cancelled yang SO-nya turut dibatalkan)
    # tidak tersentuh di sini — gate overbooking menapis status
    # 'Cancelled', nilai lamanya tidak memberi kesan.
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
                    "Resync booked_pax booking " + str(booking_name) +
                    " dari SO " + str(so_name) + " gagal.",
                    "Booked Pax Resync Error"
                )
    frappe.db.commit()
