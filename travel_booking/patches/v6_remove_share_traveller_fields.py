"""Buang custom field share-traveller dari Sales Order + backfill link.

Reka bentuk baharu (rujuk api/cabin_sharing.py): SO traveller tambahan
TIADA LAGI membawa custom field — dikenalpasti melalui
Sales Order.custom_booking + BUKAN SO primary booking + menjual item
TRAVEL-PKG; cabin dibaca dari description item; idempotensi aktivasi
melalui Booking Reservation.sales_order (field baharu doctype tu).

Patch ni:
1. Backfill Booking Reservation.sales_order daripada marker lama
   (Sales Order.custom_share_traveller_reservation) — supaya SO lama
   yang TELAH diaktifkan tidak diaktifkan semula (double slot) selepas
   field marker dibuang.
2. Delete Custom Field Sales Order/custom_share_traveller_cabin dan
   Sales Order/custom_share_traveller_reservation.

Idempoten — selamat dijalankan berulang. WAJIB berjalan sekali dengan
deploy kod baharu (bench migrate) sebelum sebarang payment event,
jika tidak SO share lama yang dah aktif boleh dikesan sebagai pending.
"""

import frappe


def execute():
    # 1. Backfill sales_order pada reservation daripada marker lama.
    #    Guard has_column() untuk site yang tiada field tu langsung.
    #    Guard kolum reservation pula untuk site baru yang tak lagi ada
    #    Booking Reservation.sales_order (dibuang oleh v11 — rujuk
    #    patches/v11_reservation_so_to_so_flag.py).
    if (frappe.db.has_column("Sales Order", "custom_share_traveller_reservation")
            and frappe.db.has_column("Booking Reservation", "sales_order")):
        legacy = frappe.db.sql("""
            SELECT so.name AS so_name, so.custom_share_traveller_reservation AS marker
            FROM `tabSales Order` so
            WHERE IFNULL(so.custom_share_traveller_reservation, '') != ''
        """, as_dict=True)
        for row in legacy:
            if frappe.db.exists("Booking Reservation", row.marker):
                frappe.db.set_value(
                    "Booking Reservation", row.marker,
                    "sales_order", row.so_name, update_modified=False)

    # 2. Buang custom field share-traveller dari Sales Order (v3 yang
    #    menciptanya dibiarkan seperti asal — install baru: v3 cipta →
    #    v6 buang; site sedia ada: v6 buang terus. Keadaan akhir sama.)
    for fieldname in ("custom_share_traveller_cabin", "custom_share_traveller_reservation"):
        if frappe.db.exists("Custom Field", {"dt": "Sales Order", "fieldname": fieldname}):
            frappe.delete_doc(
                "Custom Field", "Sales Order-" + fieldname,
                ignore_permissions=True)
