"""Gugurkan column Booking.manual_transfer_cashback_percent daripada DB.

Field dah dibuang daripada booking.json (kelayakan cashback kini
di-derive semasa bayaran daripada checkout_method + Travel Settings —
rujuk so_helpers._get_booking_discount_snapshot()), tetapi schema sync
Frappe TIDAK auto-drop column medan yang dibuang — jadi patch ni yang
gugurkan secara eksplisit.

Jalankan SELEPAS v9_backfill_checkout_method (pre_model_sync) — nilai
lama dah dipindahkan ke checkout_method sebelum column ni hilang.

Idempoten — delete_fields() hanya drop column yang benar-benar wujud.
"""

import frappe
from frappe.model import delete_fields


def execute():
    if not frappe.db.has_column("Booking", "manual_transfer_cashback_percent"):
        return

    delete_fields({"Booking": ["manual_transfer_cashback_percent"]}, delete=1)
