"""Gugurkan column Booking Reservation.is_custom_arrangement daripada DB.

Field "Custom Room Arrangement" dah dibuang daripada booking_reservation.json
— declaration lock susunan bilik tidak lagi diperlukan (rujuk papan
Rooming Board: lock tunggal yang berbaki ialah cabin_is_confirmed).

Schema sync Frappe TIDAK auto-drop column medan yang dibuang daripada
doctype, jadi patch ni yang gugurkan secara eksplisit. Daftar di bawah
[post_model_sync] — doctype sync buang field metadata dahulu, kemudian
patch drop column fizikal.

Idempoten — keluar awal bila column tiada.
"""

import frappe
from frappe.model import delete_fields


def execute():
    if not frappe.db.has_column("Booking Reservation", "is_custom_arrangement"):
        return

    delete_fields({"Booking Reservation": ["is_custom_arrangement"]}, delete=1)
