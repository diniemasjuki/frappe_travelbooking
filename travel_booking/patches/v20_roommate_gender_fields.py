"""Roommate matching (wizard /booknow) — custom field gender pada SO Item.

Sales Order Item.custom_roommate_gender — snapshot gender diisytiharkan
sendiri customer ("Male" / "Female") untuk cabin cruise SOLO yang bertanda
custom_room_privacy = "Open Sharing". Di-set oleh _build_so_items() masa
confirm_booking(); dibaca oleh _cabin_layout_from_so() supaya nilai
dialirkan ke Booking Reservation.roommate_gender bila booking diaktifkan
(SO = sumber tunggal layout cabin). Matcher (api/roommate_matching.py)
kemudian memadankan slot dengan roommate booking lain: gender SAMA +
room_category SAMA, tertakluk pada kekosongan main capacity — Room ID
slot yang dijumpai disalin ke slot baharu. Harga TIDAK diubah oleh
matcher; penyelesaian supplement dikendalikan admin secara manual.

Idempoten — selamat dipanggil berulang (corak v3_so_item_room_privacy).
"""

import frappe


def _ensure_custom_field(spec):
	if frappe.db.exists("Custom Field", {"dt": spec["dt"], "fieldname": spec["fieldname"]}):
		return
	frappe.get_doc(dict(doctype="Custom Field", **spec)).insert(ignore_permissions=True)


def execute():
	_ensure_custom_field({
		"dt":              "Sales Order Item",
		"fieldname":       "custom_roommate_gender",
		"label":           "Roommate Gender (Declared)",
		"fieldtype":       "Select",
		"options":         "Male\nFemale",
		"insert_after":    "custom_room_privacy",
		"description":     (
			"Self-declared gender for roommate matching on single-occupancy "
			"cruise cabins marked 'Open Sharing'. Empty = no match request "
			"(legacy bookings / Private cabins)."
		),
		"print_hide":      1,
		"allow_on_submit": 1,
	})
