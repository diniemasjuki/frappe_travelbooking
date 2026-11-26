"""Fasa 1A renovation: struktur SO item yang sebenar (buang parsing description).

Selama ni semua baris cabin booking guna item generik `TRAVEL-PKG` dan maklumat
kabin (room category / cabin no / pax type / trip package / group date)
diseludup dalam TEKS `description` ("Trip | Group | Room Category | Cabin N |
Pax Type") lalu di-parse semula oleh `_cabin_layout_from_so()` dan
`cabin_sharing.py` — rapuh (stale rename, free-text format, tiada integrity).

Patch ni menambah custom fields BERSTRUKTUR pada Sales Order Item supaya data
kabin hidup sebagai kolom sebenar:

- custom_room_category   — Link → Trip Price Category (kategori bilik/cabin)
- custom_cabin_no        — Int (turutan cabin dalam booking, mula 1)
- custom_pax_type        — Select (Main Guest / Main Guest (Single) / Extra Bed /
                           Infant / Adult / Children — label pax_type sedia ada)
- custom_trip_package    — Link → Trip Package
- custom_trip_group_date — Link → Trip Group Date

Kod baharu (_build_so_items / _so_line / cabin_sharing) menulis fields ni pada
setiap baris SO cabin; pembaca (_cabin_layout_from_so, _share_so_lines)
ditukar baca fields ni dahulu dan fallback ke parse description lama untuk
dokumen berumur. Description teks KEKAL ditulis untuk kebolehbacaan invoice.

Patch juga BACKFILL dokumen lama: parse description sekali dan isi custom
fields untuk semua baris SO cabin sedia ada (item TRAVEL-PKG) yang kosong.

Fasa 1B: tambah fields upgrade cabin pada Trip Addon Package —
`is_cabin_upgrade` + `upgrade_from_category` / `upgrade_to_category` — supaya
upgrade cabin selepas tempahan boleh dijual sebagai addon package (rates,
scoping, cutoff sedia ada dipakai terus).

Idempoten — selamat dijalankan berulang.
"""

import frappe


def _ensure_custom_field(spec):
	"""Idempoten per-field — selamat dipanggil berulang (patch mungkin
	dilanjutkan dengan field baharu pada release selepas ia pertama kali
	dijalankan di sesetengah site)."""
	if frappe.db.exists("Custom Field", {"dt": spec["dt"], "fieldname": spec["fieldname"]}):
		return
	frappe.get_doc(dict(doctype="Custom Field", **spec)).insert(ignore_permissions=True)


# ── Backfill helper ──────────────────────────────────────────────────

def _parse_legacy_description(description):
	"""'Trip | Group Label | Room Category | Cabin N | Pax Type' → dict.

	Return None bila description bukan corak cabin booking lama.
	"""
	parts = (description or "").split(" | ")
	if len(parts) < 5:
		return None
	try:
		cabin_no = int(parts[3].strip().lower().replace("cabin", "").strip())
	except (ValueError, TypeError):
		return None
	return {
		"room_category": parts[2].strip(),
		"cabin_no": cabin_no,
		"pax_type": parts[4].strip(),
	}


def _backfill_so_item_fields():
	"""Isi custom fields cabin untuk SEMUA baris SO cabin lama (item
	TRAVEL-PKG) yang belum ada custom_room_category.

	Parse description teks lama — sumber satu-satunya untuk dokumen
	berumur. Baris yang gagal parse (description bukan corak cabin,
	cth baris legacy tanpa segmen) dibiarkan kosong; pembaca baharu
	fallback ke description untuknya.
	"""
	so_items = frappe.db.sql("""
		SELECT soi.name, soi.description
		FROM `tabSales Order Item` soi
		JOIN `tabSales Order` so ON so.name = soi.parent
		WHERE soi.parenttype = 'Sales Order'
		  AND soi.item_code = 'TRAVEL-PKG'
		  AND IFNULL(soi.custom_room_category, '') = ''
	""", as_dict=True)

	for it in so_items:
		parsed = _parse_legacy_description(it.description)
		if not parsed:
			continue
		if not frappe.db.exists("Trip Price Category", parsed["room_category"]):
			# Stale rename — jangan tulis link rosak; kekal kosong supaya
			# pembaca fallback ke description (corak guard _activate_booking).
			continue
		frappe.db.set_value("Sales Order Item", it.name, {
			"custom_room_category": parsed["room_category"],
			"custom_cabin_no":       parsed["cabin_no"],
			"custom_pax_type":       parsed["pax_type"],
		}, update_modified=False)


def _backfill_trip_group_date_and_package():
	"""Isi custom_trip_package / custom_trip_group_date untuk baris SO cabin
	daripada Booking yang dipaut (SO.custom_booking).

	SO cabin sentiasa dipaut ke Booking melalui custom_booking (utama +
	traveller tambahan + cabin baharu) dan Booking membawa trip_package +
	trip_date — jadi snapshot per-baris boleh diisi dari situ untuk semua
	SO lama tanpa parse apa-apa teks.
	"""
	so_items = frappe.db.sql("""
		SELECT soi.name, so.custom_booking, so.custom_booking_addon
		FROM `tabSales Order Item` soi
		JOIN `tabSales Order` so ON so.name = soi.parent
		JOIN `tabBooking` b ON b.name = so.custom_booking
		WHERE soi.parenttype = 'Sales Order'
		  AND soi.item_code = 'TRAVEL-PKG'
		  AND IFNULL(soi.custom_trip_group_date, '') = ''
		  AND IFNULL(so.custom_booking, '') != ''
	""", as_dict=True)

	booking_cache = {}
	for it in so_items:
		booking_name = it.custom_booking
		if booking_name not in booking_cache:
			booking_cache[booking_name] = frappe.db.get_value(
				"Booking", booking_name, ["trip_package", "trip_date"], as_dict=True) or frappe._dict()
		b = booking_cache[booking_name]
		if not (b.trip_package or b.trip_date):
			continue
		updates = {}
		if b.trip_package:
			updates["custom_trip_package"] = b.trip_package
		if b.trip_date:
			updates["custom_trip_group_date"] = b.trip_date
		frappe.db.set_value("Sales Order Item", it.name, updates, update_modified=False)


def execute():
	# ── 1. Sales Order Item — custom fields cabin berstruktur ─────────
	_soitem_specs = [
		{
			"dt":              "Sales Order Item",
			"fieldname":       "custom_room_category",
			"label":           "Room Category",
			"fieldtype":       "Link",
			"options":         "Trip Price Category",
			"insert_after":    "description",
			"description":     (
				"Category bilik/cabin booking (snapshot masa SO dicipta). "
				"Kosong = baris SO lama sebelum struktur — pembaca fallback "
				"ke parse description."
			),
			"print_hide":      1,
			"allow_on_submit": 1,
		},
		{
			"dt":              "Sales Order Item",
			"fieldname":       "custom_cabin_no",
			"label":           "Cabin No",
			"fieldtype":       "Int",
			"insert_after":    "custom_room_category",
			"description":     (
				"Turutan cabin dalam booking (mula 1) — sumber tunggal "
				"layout kabin bersama custom_room_category."
			),
			"print_hide":      1,
			"allow_on_submit": 1,
		},
		{
			"dt":              "Sales Order Item",
			"fieldname":       "custom_pax_type",
			"label":           "Pax Type",
			"fieldtype":       "Select",
			"options":         ("Main Guest\nMain Guest (Single)\nExtra Bed\n"
			                    "Infant\nAdult\nChildren\nMain Guest (Additional)\n"
			                    "Extra Bed (Additional)\nInfant (Additional)"),
			"insert_after":    "custom_cabin_no",
			"description":     (
				"Jenis pax baris ni — label pax_type sedia ada yang "
				"ditulis pada description; kini sebagai kolom berstruktur."
			),
			"print_hide":      1,
			"allow_on_submit": 1,
		},
		{
			"dt":              "Sales Order Item",
			"fieldname":       "custom_trip_package",
			"label":           "Trip Package",
			"fieldtype":       "Link",
			"options":         "Trip Package",
			"insert_after":    "custom_pax_type",
			"description":     (
				"Pakej tempatan baris ni (snapshot). Dipakai oleh laporan & "
				"pembaca komposisi pakej (Fasa 2)."
			),
			"print_hide":      1,
			"allow_on_submit": 1,
		},
		{
			"dt":              "Sales Order Item",
			"fieldname":       "custom_trip_group_date",
			"label":           "Trip Group Date",
			"fieldtype":       "Link",
			"options":         "Trip Group Date",
			"insert_after":    "custom_trip_package",
			"description":     (
				"Tarikh perjalanan baris ni (snapshot). Dipakai oleh "
				"pembaca allotment & laporan."
			),
			"print_hide":      1,
			"allow_on_submit": 1,
		},
	]
	for spec in _soitem_specs:
		_ensure_custom_field(spec)

	# ── 2. Trip Addon Package — fields upgrade cabin (Fasa 1B) ────────
	_tap_specs = [
		{
			"dt":              "Trip Addon Package",
			"fieldname":       "is_cabin_upgrade",
			"label":           "Is Cabin Upgrade",
			"fieldtype":       "Check",
			"insert_after":    "addon_package_name",
			"description":     (
				"Tanda jika package ni menjual UPGRADE cabin/kategori bilik "
				"(contoh: Interior → Balcony). Bila aktif, katalog portal "
				"menyenaraikan pilihan upgrade sah untuk kategori semasa "
				"customer dan apply-nya menukar Booking Reservation."
			),
		},
		{
			"dt":              "Trip Addon Package",
			"fieldname":       "upgrade_from_category",
			"label":           "Upgrade From Category",
			"fieldtype":       "Link",
			"options":         "Trip Price Category",
			"insert_after":    "is_cabin_upgrade",
			"depends_on":      "eval:doc.is_cabin_upgrade",
			"description":     (
				"Kategori SEMASA customer (asal) — package hanya muncul "
				"untuk reservation kategori ini."
			),
		},
		{
			"dt":              "Trip Addon Package",
			"fieldname":       "upgrade_to_category",
			"label":           "Upgrade To Category",
			"fieldtype":       "Link",
			"options":         "Trip Price Category",
			"insert_after":    "upgrade_from_category",
			"depends_on":      "eval:doc.is_cabin_upgrade",
			"description":     (
				"Kategori SASARAN selepas upgrade — Booking Reservation "
				"room_category ditukar ke nilai ni bila addon dibayar penuh."
			),
		},
	]
	for spec in _tap_specs:
		_ensure_custom_field(spec)

	# ── 3. Backfill dokumen lama ──────────────────────────────────────
	_backfill_so_item_fields()
	_backfill_trip_group_date_and_package()
