"""Backfill Booking.checkout_method daripada penanda cashback lama.

Field checkout_method dahulu wujud dalam schema tetapi TIDAK PERNAH
ditulis (penciptaan booking tak set ia). Bermula dengan refaktor ni,
confirm_booking menulisnya daripada payment_method wizard, dan
manual_transfer_cashback_percent dibuang daripada Booking (kelayakan
cashback kini di-derive semasa bayaran daripada checkout_method +
Travel Settings — rujuk so_helpers._get_booking_discount_snapshot()).

Booking lama yang layak cashback (manual_transfer_cashback_percent > 0)
maksudnya dibuat melalui laluan Manual Transfer — backfill
checkout_method = "Manual Transfer" supaya bayaran baki portal mereka
kekal layak cashback selepas column lama digugurkan oleh schema sync.

WAJIB berjalan pada fasa pre_model_sync (sebelum column
manual_transfer_cashback_percent dibuang). Idempoten — hanya isi
checkout_method yang masih kosong.
"""

import frappe


def execute():
    if not frappe.db.has_column("Booking", "manual_transfer_cashback_percent"):
        return

    frappe.db.sql("""
        UPDATE `tabBooking`
        SET checkout_method = 'Manual Transfer'
        WHERE IFNULL(checkout_method, '') = ''
          AND IFNULL(manual_transfer_cashback_percent, 0) > 0
    """)
