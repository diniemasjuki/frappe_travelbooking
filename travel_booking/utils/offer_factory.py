# travel_booking/utils/offer_factory.py
#
# Faktori Package Offer (F2) — SATU laluan penciptaan offer daripada
# Travel Package (salin matriks harga daripada templat + jana baris
# inventori daripada paksi ber-sifat "inventory").
#
# Diguna oleh:
#   - patch v40 (migrasi TGD → offer, dengan seed allotment/sold)
#   - api/package_admin.generate_offer_from_template (offer baharu oleh staf)
#
# Prinsip: offer TIDAK meniru data ops (jadual kapal/penerbangan dirujuk);
# yang disalin hanyalah TEMPLET HARGA + INVENTORI (kerana itu berubah
# per-keberangkatan).

import frappe

AGE_OPTIONS = [
	("ADULT", "Adult (12+)"), ("CHILD", "Child (5-11)"),
	("INFANT", "Infant (0-23mo)"), ("TODDLER", "Toddler (2-4)"),
]

STATUS_EDITORIAL_MAP = {
	"Active": "Active", "Pending Review": "Draft", "Cancelled": "Cancelled",
	"Running": "Active", "Sailing": "Active", "Full": "Active",
	"Closed": "Active", "Completed": "Active",
}
STATUS_OPERATIONAL_MAP = {
	"Active": "Scheduled", "Pending Review": "Scheduled", "Cancelled": "Scheduled",
	"Running": "Running", "Sailing": "Sailing", "Full": "Full",
	"Closed": "Closed", "Completed": "Completed",
}


def _inventory_axes(pkg):
	"""Paksi ber-sifat inventory, tersusun ikut sort_order — menentukan
	format kanonik inventory_key."""
	axes = [ax for ax in (pkg.variant_axes or []) if ax.nature == "inventory"]
	return sorted(axes, key=lambda a: (a.sort_order or 0))


def _options_by_axis(pkg):
	opts: dict = {}
	for o in (pkg.variant_options or []):
		opts.setdefault(o.axis_code, []).append(o)
	for code in opts:
		opts[code].sort(key=lambda o: (o.sort_order or 0))
	return opts


def inventory_keys_for(pkg):
	"""Set inventory_key sah untuk pakej — hasil darab Cartesius paksi
	inventory (cth: 'cabin:BALCONY', 'cabin:BALCONY|occ:TWIN')."""
	axes = _inventory_axes(pkg)
	if not axes:
		return []
	opts = _options_by_axis(pkg)
	combo = [{}]
	for ax in axes:
		new = []
		for base in combo:
			for o in opts.get(ax.axis_code, []):
				item = dict(base)
				item[ax.axis_code] = o.option_code
				new.append(item)
		combo = new
	keys = []
	for item in combo:
		key = "|".join(f"{ax}:{item[ax]}" for ax in (a.axis_code for a in axes) if ax in item)
		if key:
			keys.append(key)
	return keys



def _create_offer_standalone(values: dict) -> str:
	"""Cipta offer TANPA Travel Package (mod standalone). Prasyarat:
	values: travel_date (wajib), offer_name (nama pakej, wajib),
	currency (wajib). [BUANG Nov 2026] seed komponen (Offer Component) —
	field ditanggalkan; komponen aktif dibaca terus daripada
	Trip.default_components. Inventori: satu baris bagi setiap kategori
	rooming tarikh (allotment 0 — kolam kontrak dikongsi semua group
	sailing sama). Harga: kosong."""
	td = frappe.db.get_value(
		"Travel Date", values["travel_date"],
		["name", "trip", "departure_date", "return_date", "sailing_start",
		 "sailing_end", "ship_name", "ship_code", "embarkation_port",
		 "disembarkation_port", "cruise_schedule", "days_before_closure"],
		as_dict=True)
	if not td:
		frappe.throw("Travel Date {} not found.".format(values["travel_date"]))
	if not values.get("offer_name") or not values.get("currency"):
		frappe.throw("Offer name and currency are required.")
	data = {
		"doctype": "Package Offer",
		"naming_series": "OFF-.YYYY.-.####",
		"package": None,
		"offer_name": values["offer_name"],
		"currency": values["currency"],
		"travel_date": td.name,
		"departure_date": td.departure_date,
		"return_date": td.return_date,
		"sailing_start": td.sailing_start, "sailing_end": td.sailing_end,
		"ship_name": td.ship_name, "ship_code": td.ship_code,
		"embarkation_port": td.embarkation_port,
		"disembarkation_port": td.disembarkation_port,
		"cruise_schedule": td.cruise_schedule,
		"days_before_closure": td.days_before_closure,
	}
	offer = frappe.get_doc(data)
	# [BUANG Nov 2026] seeding Offer Inventory — medan inventori per-variant
	# ditanggalkan daripada Package Offer. Kapasiti cruise = Sailing
	# Inventory kolam kongsi; kapasiti offer = max_pax/current_pax.
	offer.insert(ignore_permissions=True, ignore_links=True)
	return offer.name


def create_offer(package: str, values: dict, inventory_seeds: dict = None) -> str:
	"""Cipta Package Offer daripada Travel Package.

	:param package: nama Travel Package
	:param values: medan offer. Dua mod:
	    - MOD TRAVEL DATE (hierarki ERD, diutamakan): hantar `travel_date`
	      (nama Travel Date) — tarikh/sailing/ship/port/cruise_schedule
	      diambil DARIPADA Travel Date (satu sumber kebenaran; nilai lain
	      dalam values untuk medan tersebut diabaikan).
	    - MOD LEGACY: hantar `departure_date` terus (patch v40 / laluan
	      lama) — kelakuan asal tidak berubah.
	    status_editorial/status_operational boleh dihantar; default
	    Draft/Scheduled.
	:param inventory_seeds: TIDAK DIGUNAKAN lagi (Nov 2026 — medan
	    inventori per-variant ditanggalkan; kekal untuk keserasian panggilan
	    patch migrasi v40).
	:return: nama offer yang dicipta
	"""
	values = dict(values or {})
	if not package and values.get("travel_date"):
		# MOD OFFER (Nov 2026 — Travel Package deprecated): offer identiti
		# sendiri — nama + currency dihantar pemanggil; komponen disalin
		# daripada Trip.default_components; HARGA diisi melalui Price
		# Matrix (import schedule rates).
		return _create_offer_standalone(values)

	pkg = frappe.get_doc("Travel Package", package)
	data = {
		"doctype": "Package Offer",
		"naming_series": "OFF-.YYYY.-.####",
		"package": pkg.name,
	}
	if values.get("travel_date"):
		td = frappe.db.get_value(
			"Travel Date", values["travel_date"],
			["name", "trip", "departure_date", "return_date",
			 "sailing_start", "sailing_end", "ship_name", "ship_code",
			 "embarkation_port", "disembarkation_port",
			 "cruise_schedule", "days_before_closure"], as_dict=True)
		if not td:
			frappe.throw(
				"Travel Date {} not found.".format(values["travel_date"]))
		# Tarikh & sailing HANYA daripada Travel Date — buang sebarang
		# nilai bertindih yang dihantar pemanggil (elak drift).
		for f in ("departure_date", "return_date", "sailing_start",
				  "sailing_end", "ship_name", "ship_code",
				  "embarkation_port", "disembarkation_port",
				  "cruise_schedule", "days_before_closure"):
			values.pop(f, None)
			if td.get(f) is not None:
				values[f] = td.get(f)
	data.update(values)
	offer = frappe.get_doc(data)

	# [BUANG Nov 2026] salinan matriks harga templat → Offer Price DAN
	# janaan inventori per-variant — kedua-dua medan ditanggalkan daripada
	# Package Offer. Harga = Price Matrix (import schedule rates); kapasiti
	# = Sailing Inventory (cruise) / max_pax (darat).

	# [BUANG Nov 2026] stamping komponen (Offer Component) — field
	# ditanggalkan; komponen aktif dibaca terus daripada
	# Trip.default_components.

	offer.insert(ignore_permissions=True, ignore_links=True)
	return offer.name


def seeds_from_allotment(pkg, old_package_name: str) -> dict:
	"""Seed allotment daripada cabin_allotment harga lama (Trip Package Price)
	untuk pakej baharu — dipakai patch v40. sold di-backfill berasingan
	(dari reservasi) oleh patch."""
	seeds: dict = {}
	rows = frappe.get_all(
		"Trip Package Price",
		filters={"parent": old_package_name},
		fields=["pricing_for_class", "cabin_allotment"],
	)
	# category docname → option_code ( Variant Option paksi cabin pakej ni)
	code_map = {
		o.option_code: o.option_code
		for o in (pkg.variant_options or []) if o.axis_code == "cabin"
	}
	# option_code boleh jadi category_code ATAU docname (fallback v39) —
	# bina peta dua hala melalui Trip Price Category
	cat_names = frappe.get_all(
		"Trip Price Category", fields=["name", "category_code"]
	)
	docname_to_code = {
		c.name: (c.category_code or c.name) for c in cat_names
	}
	for o in (pkg.variant_options or []):
		if o.axis_code == "cabin":
			code_map[docname_to_code.get(o.option_code, o.option_code)] = o.option_code

	for r in rows:
		code = docname_to_code.get(r.pricing_for_class, r.pricing_for_class)
		opt = code_map.get(code)
		if not opt:
			continue
		key = f"cabin:{opt}"
		seeds[key] = {"allotment": int(r.cabin_allotment or 0), "sold": 0}
	return seeds


def sold_from_reservations(tgd_name: str, old_package_name: str = None) -> dict:
	"""Sold per cabin UNTUK SATU keberangkatan (TGD lama) — kiraan KABIN
	(reservasi tak-cancelled melalui Booking.trip_date, dikumpul ikut
	room_id — tetamu berkongsi kabin tidak di-kira berasingan).

	FILTER PENTING (bug v40 #1): reservasi MILIK SATU pakej — tanpa filter
	`b.trip_package`, pakej FC dan CO yang sama-sama pilih TGD akan
	DUPLICAT-KIRA reservasi yang sama pada dua offer berbeza.
	Kembalikan {category_docname: n}."""
	values = {"tgd": tgd_name}
	package_filter = ""
	if old_package_name:
		values["pkg"] = old_package_name
		package_filter = "AND b.trip_package = %(pkg)s"
	rows = frappe.db.sql(
		f"""
		SELECT br.room_category AS cat,
		       COUNT(DISTINCT COALESCE(NULLIF(br.room_id, ''), br.name)) AS n
		FROM `tabBooking Reservation` br
		INNER JOIN `tabBooking` b ON b.name = br.booking
		WHERE b.trip_date = %(tgd)s
		  {package_filter}
		  AND br.status != 'Cancelled'
		  AND br.room_category IS NOT NULL AND br.room_category != ''
		GROUP BY br.room_category
		""",
		values,
		as_dict=True,
	)
	return {r.cat: int(r.n) for r in rows}


# ══════════════════════════════════════════════
# F5 — aliran tulis booking ke struktur baharu (flag use_package_offers)
# ══════════════════════════════════════════════

def resolve_legacy_from_offer(offer_name: str, travel_package_name: str):
	"""Offer baharu → NAMA WARISAN (TGD + Trip Package lama) melalui
	provenance. Bila flag ON, confirm_booking delegate ke SELURUH aliran
	lama guna nama-nama ni — kapasiti/harga/SO/perakaunan tak tersentuh.
	Throw jelas kalau provenance belum lengkap (pakej/offer luar skrip
	migrasi v39/v40)."""
	offer = frappe.db.get_value(
		"Package Offer", offer_name,
		["legacy_tgd", "legacy_trip_package", "package", "currency"],
		as_dict=True,
	)
	if not offer:
		frappe.throw(f"Offer {offer_name} not found.", frappe.DoesNotExistError)
	# RELAXED (Nov 2026 — Travel Package deprecated penuh): offer dengan
	# identiti sendiri (currency) berjalan OFFER-MODE — pricing dari
	# Offer Price, trip_package TIDAK diperlukan. legacy_tgd kekal wajib
	# (TGD masih sumber tarikh/ops aliran legacy). Offer warisan (tanpa
	# currency) kekal mewajibkan provenance penuh.
	if offer.currency:
		if not offer.legacy_tgd:
			frappe.throw(
				"Offer {0} tiada provenance TGD (legacy_tgd kosong) — "
				"tarikh operasi tidak dapat diselesaikan.".format(offer_name))
		return offer.legacy_tgd, None
	pkg_legacy = frappe.db.get_value(
		"Travel Package", travel_package_name, "legacy_trip_package"
	)
	if not offer.legacy_tgd or not pkg_legacy:
		frappe.throw(
			"Provenance legacy belum lengkap untuk offer warisan ini "
			"(legacy_tgd / legacy_trip_package kosong, dan currency "
			"tiada). Flag use_package_offers tidak boleh digunakan."
		)
	return offer.legacy_tgd, pkg_legacy


def _selection_needs(selections) -> dict:
	"""Bilangan KABIN per inventory_key daripada selections wizard.

	Inventori cruise schedule (cabin_rates) mengira BILIK/KABIN, bukan
	penumpang — setiap selection wizard = SATU kabin kategori
	room_category (docname Trip Price Category → category_code →
	'cabin:CODE'). Tetamu berkongsi kabin (room_id sama pada Booking
	Reservation) — tambah infant/extra bed TIDAK mengambil kabin baharu.
	Selection kosong (tiada tetamu) tidak dikira."""
	needs: dict = {}
	codes: dict = {}
	for s in selections or []:
		rc = s.get("room_category")
		if not rc:
			continue
		guests = (int(s.get("main_guests", 0) or 0)
				  + int(s.get("extra_beds", 0) or 0)
				  + int(s.get("infants", 0) or 0))
		if guests <= 0:
			continue
		if rc not in codes:
			codes[rc] = frappe.db.get_value(
				"Trip Price Category", rc, "category_code"
			) or rc
		key = "cabin:" + codes[rc]
		needs[key] = needs.get(key, 0) + 1
	return needs


# ── GATE KAPASITI (Nov 2026 — konsolidasi tunggal) ────────────────────
# Kolam kapasiti cruise = cabin_rates pada Trip Cruise Schedule
# (child Trip Package Price): cabin_allotment (kontrak) − cabin_occupancy
# (kiraan live Booking Reservation, disegerak hooks sync_cabin_availability).
# [BUANG] Sailing Inventory (kolam selari), apply/release_offer_booking,
# snapshot offer_inventory_snapshot — pembatalan reservasi mengosongkan
# kuota secara automatik melalui kiraan semula hook.
# Offer darat (tanpa schedule): tiada had per-variant — jualan terbuka.


def check_offer_capacity(offer_name: str, selections, partner: str = None):
	"""Gate kapasiti — LOCK baris Trip Cruise Schedule (SELECT ... FOR
	UPDATE, serialise booking serentak) kemudian semak setiap kategori
	pilihan ada tempat cukup pada kolam cabin_rates schedule. Dipanggil
	SEBELUM aliran confirm_booking; lock kekal sehingga transaksi commit.
	Partner reserve (Fasa C) dibuang bersama Sailing Inventory."""
	schedule = frappe.db.get_value("Package Offer", offer_name, "cruise_schedule")
	if isinstance(schedule, dict):
		schedule = schedule.get("cruise_schedule")
	if not schedule or not frappe.db.exists("Trip Cruise Schedule", schedule):
		return  # offer darat — tiada kolam, jualan terbuka

	# Serialise booking pada sailing ini (lock baris induk schedule).
	frappe.db.sql(
		"SELECT name FROM `tabTrip Cruise Schedule` WHERE name = %s FOR UPDATE",
		(schedule,),
	)
	needs = _selection_needs(selections)
	if not needs:
		return

	# Kolam: cabin_rates schedule — {docname kategori: (allotment, occupancy)}
	pool = {
		r.pricing_for_class: (int(r.cabin_allotment or 0),
							  int(r.cabin_occupancy or 0))
		for r in frappe.get_all(
			"Trip Package Price",
			filters={"parent": schedule, "parenttype": "Trip Cruise Schedule"},
			fields=["pricing_for_class", "cabin_allotment", "cabin_occupancy"],
		)
	}
	codes = {}
	for cat_name in pool:
		codes.setdefault(frappe.db.get_value(
			"Trip Price Category", cat_name, "category_code") or cat_name,
			cat_name)

	for key, rooms in needs.items():
		code = key.split(":", 1)[1] if ":" in key else key
		cat_name = codes.get(code)
		if not cat_name or cat_name not in pool:
			frappe.throw(
				f"Kabin '{code}' tiada dalam kolam kategori sailing "
				f"{schedule} — tak boleh dijual."
			)
		allotment, occupancy = pool[cat_name]
		avail = allotment - occupancy
		if avail < rooms:
			frappe.throw(
				f"{code}: hanya {max(0, avail)} kabin tinggal pada sailing "
				f"(kolam kontrak dikongsi semua group) — perlukan {rooms} kabin."
			)
