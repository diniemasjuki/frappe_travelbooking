"""Pindah idempotensi share-traveller dari Booking Reservation ke Sales Order.

Reka bentuk baharu (rujuk api/cabin_sharing.py): Booking Reservation TIDAK
LAGI menyimpan rujukan SO (field sales_order dibuang dari doctype) — SO
dipaut ke Booking sahaja melalui Sales Order.custom_booking (satu booking
boleh ada beberapa SO). Idempotensi aktivasi slot traveller tambahan kini
melalui flag Sales Order.custom_share_slot_activated.

Patch ni:
1. Pastikan custom field Sales Order/custom_share_slot_activated wujud
   (site baru juga diliputi di sini — patch berjalan atas semua site).
2. Backfill flag = 1 untuk SEMUA SO yang masih ada reservation
   bersales_order dengannya (termasuk SO utama — flag pada SO utama
   tak diambil kira mana-mana logik, jadi ia tak bermudarat) SEBELUM
   kolum lama dibuang — supaya SO lama yang TELAH diaktifkan tidak
   diaktifkan semula (double slot) selepas upgrade.
3. Buang kolum Booking Reservation.sales_order (Frappe tidak buang
   kolum automatik bila field dibuang dari doctype JSON).

Idempoten — selamat dijalankan berulang. WAJIB berjalan sekali dengan
deploy kod baharu (bench migrate) sebelum sebarang payment event, jika
tidak SO share lama yang dah aktif boleh dikesan sebagai pending.
"""

import frappe
from frappe.model import delete_fields


def _ensure_custom_field(spec):
	"""Idempoten per-field — selamat dipanggil berulang."""
	if frappe.db.exists("Custom Field", {"dt": spec["dt"], "fieldname": spec["fieldname"]}):
		return
	frappe.get_doc(dict(doctype="Custom Field", **spec)).insert(ignore_permissions=True)


def execute():
	_ensure_custom_field({
		"dt":              "Sales Order",
		"fieldname":       "custom_share_slot_activated",
		"label":           "Share Slot Activated",
		"fieldtype":       "Check",
		"insert_after":    "custom_booking_addon",
		"description": (
			"Set automatically when this additional-traveller Sales Order "
			"(non-primary, TRAVEL-PKG item) has been activated into a "
			"Booking Reservation slot. Used for cabin-sharing activation "
			"idempotency — the reservation itself stores no Sales Order "
			"reference."
		),
		"print_hide":      1,
		"read_only":       1,
		"allow_on_submit": 1,
		"no_copy":         1,
	})

	# 2 + 3. Backfill flag daripada stamp lama, kemudian buang kolum.
	if not frappe.db.has_column("Booking Reservation", "sales_order"):
		return  # site baru / dah dimigrasi — tiada apa-apa untuk dibuat

	frappe.db.sql("""
		UPDATE `tabSales Order` so
		SET so.custom_share_slot_activated = 1
		WHERE IFNULL(so.custom_share_slot_activated, 0) = 0
		  AND EXISTS (
		      SELECT 1 FROM `tabBooking Reservation` br
		      WHERE br.sales_order = so.name)
	""")
	# Helper rasmi Frappe (frappe.model.delete_fields) — buang DocField
	# baki (no-op kalau sync dah buang) DAN drop kolum datanya.
	delete_fields({"Booking Reservation": ["sales_order"]}, delete=1)
