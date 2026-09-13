"""Tambah custom fields pada Sales Order / Sales Order Item untuk
room sharing (cruise solo) — Fasa pilihan privacy + tambah traveller.

1. Sales Order Item.custom_room_privacy — snapshot pilihan Room Privacy
   customer ("Private" / "Open Sharing") untuk cabin cruise 1 main
   guest. Di-set oleh _build_so_items() masa confirm_booking(); dibaca
   oleh _cabin_layout_from_so() supaya nilai boleh dialirkan ke
   Booking Reservation.room_privacy bila booking diaktifkan
   (SO = sumber tunggal layout cabin). Kosong = booking lama (dianggap
   Private — behavior lama: solo bayar price_adult_single dan kekal
   private sehingga ops urus).

2. Sales Order.custom_share_traveller_cabin — nombor cabin sasaran
   untuk SO "Additional Traveller" (tambah traveller ke cabin solo dari
   portal; rujuk api/cabin_sharing.py). 0/kosong = bukan SO ni.
   [USANG — dibuang oleh patches/v6_remove_share_traveller_fields:
   SO traveller tambahan kini dikenalpasti tanpa custom field.]

3. Sales Order.custom_share_traveller_reservation — nama Booking
   Reservation slot traveller tambahan selepas SO dibayar penuh.
   Berfungsi sebagai marker idempoten aktivasi.
   [USANG — idempotensi kini melalui Booking Reservation.sales_order.]
"""

import frappe


def _ensure_custom_field(spec):
	"""Idempoten per-field — selamat dipanggil berulang (patch mungkin
	dilanjutkan dengan field baharu pada release selepas ia pertama kali
	dijalankan di sesetengah site)."""
	if frappe.db.exists("Custom Field", {"dt": spec["dt"], "fieldname": spec["fieldname"]}):
		return
	frappe.get_doc(dict(doctype="Custom Field", **spec)).insert(ignore_permissions=True)


def execute():
	_ensure_custom_field({
		"dt":              "Sales Order Item",
		"fieldname":       "custom_room_privacy",
		"label":           "Room Privacy",
		"fieldtype":       "Select",
		"options":         "Private\nOpen Sharing",
		"insert_after":    "description",
		"description":     (
			"Customer's cabin privacy choice for single-occupancy cruise "
			"cabins (Private / Open Sharing). Empty = legacy bookings "
			"(treated as Private)."
		),
		"print_hide":      1,
		"allow_on_submit": 1,
	})

	_ensure_custom_field({
		"dt":              "Sales Order",
		"fieldname":       "custom_share_traveller_cabin",
		"label":           "Share Traveller Cabin No",
		"fieldtype":       "Int",
		"insert_after":    "custom_booking",
		"description":     (
			"Target cabin number for an 'Additional Traveller' Sales Order "
			"(room sharing, cruise solo cabins). 0 = not a share-traveller SO."
		),
		"print_hide":      1,
		"allow_on_submit": 1,
	})

	_ensure_custom_field({
		"dt":              "Sales Order",
		"fieldname":       "custom_share_traveller_reservation",
		"label":           "Share Traveller Reservation",
		"fieldtype":       "Data",
		"insert_after":    "custom_share_traveller_cabin",
		"description":     (
			"Booking Reservation slot created for the additional traveller "
			"once this Sales Order is fully paid (idempotency marker)."
		),
		"print_hide":      1,
		"allow_on_submit": 1,
		"no_copy":         1,
	})
