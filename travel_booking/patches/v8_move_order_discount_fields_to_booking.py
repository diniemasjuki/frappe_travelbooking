"""Pindahkan snapshot diskaun order-level & cashback dari Sales Order ke Booking.

Reka bentuk baharu: SO booking KEKAL GROSS tanpa sebarang custom field
diskaun. Nilai disimpan pada dokumen Booking (doctype custom app —
voucher_discount / referral_discount / manual_transfer_cashback_percent,
satu Booking per SO utama) dan pembaca Payment Entry/Stripe mengaksesnya
melalui Sales Order.custom_booking (rujuk so_helpers.
_get_booking_discount_snapshot()).

Patch ni:
1. Salin nilai lama daripada Custom Field SO (custom_voucher_discount /
   custom_referral_discount / custom_cashback_percent) ke Booking yang
   dipaut melalui custom_booking — hanya isi field Booking yang masih
   kosong/0 supaya nilai yang mungkin dah ditulis ke Booking tidak
   ditindih.
2. Delete Custom Field Sales Order/custom_cashback_percent,
   Sales Order/custom_voucher_discount dan
   Sales Order/custom_referral_discount.

Idempoten — selamat dijalankan berulang. WAJIB berjalan sekali dengan
deploy kod baharu (bench migrate) sebelum sebarang payment event, jika
tidak pembaca (portal/Stripe) akan baca snapshot diskaun kosong.
"""

import frappe


def execute():
    # 1. Backfill Booking daripada Custom Field SO lama. Guard has_column()
    #    untuk site yang tiada field tu langsung (install baharu: v4/v5
    #    cipta → v8 buang; site sedia ada: v8 buang terus. Keadaan akhir
    #    sama.)
    if (frappe.db.has_column("Sales Order", "custom_voucher_discount")
            and frappe.db.has_column("Sales Order", "custom_referral_discount")
            and frappe.db.has_column("Sales Order", "custom_cashback_percent")
            # Guard Booking: column manual_transfer_cashback_percent dibuang
            # daripada schema oleh refaktor selepas v8 — patch ni tidak
            # boleh baca column yang sudah tiada (site lama yang lari v8
            # selepas refaktor).
            and frappe.db.has_column("Booking", "manual_transfer_cashback_percent")):
        legacy = frappe.db.sql("""
            SELECT so.custom_booking AS booking,
                   COALESCE(so.custom_voucher_discount, 0)  AS voucher_discount,
                   COALESCE(so.custom_referral_discount, 0) AS referral_discount,
                   COALESCE(so.custom_cashback_percent, 0)  AS cashback_percent
            FROM `tabSales Order` so
            WHERE IFNULL(so.custom_booking, '') != ''
              AND (IFNULL(so.custom_voucher_discount, 0) != 0
                   OR IFNULL(so.custom_referral_discount, 0) != 0
                   OR IFNULL(so.custom_cashback_percent, 0) != 0)
        """, as_dict=True)
        for row in legacy:
            if not frappe.db.exists("Booking", row.booking):
                continue
            current = frappe.db.get_value(
                "Booking", row.booking,
                ["voucher_discount", "referral_discount",
                 "manual_transfer_cashback_percent"],
                as_dict=True)
            if not current:
                continue
            updates = {}
            if not float(current.voucher_discount or 0) and row.voucher_discount:
                updates["voucher_discount"] = row.voucher_discount
            if not float(current.referral_discount or 0) and row.referral_discount:
                updates["referral_discount"] = row.referral_discount
            if (not float(current.manual_transfer_cashback_percent or 0)
                    and row.cashback_percent):
                updates["manual_transfer_cashback_percent"] = row.cashback_percent
            if updates:
                frappe.db.set_value(
                    "Booking", row.booking, updates, update_modified=False)

    # 2. Buang custom field diskaun/cashback dari Sales Order.
    for fieldname in ("custom_cashback_percent",
                      "custom_voucher_discount",
                      "custom_referral_discount"):
        if frappe.db.exists("Custom Field", {"dt": "Sales Order", "fieldname": fieldname}):
            frappe.delete_doc(
                "Custom Field", "Sales Order-" + fieldname,
                ignore_permissions=True)
