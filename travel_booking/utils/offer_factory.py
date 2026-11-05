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


def create_offer(package: str, values: dict, inventory_seeds: dict = None) -> str:
	"""Cipta Package Offer daripada Travel Package.

	:param package: nama Travel Package
	:param values: medan offer (departure_date wajib, dsb.) — status_editorial/
	    status_operational boleh dihantar (patch migrasi); default Draft/Scheduled
	:param inventory_seeds: {inventory_key: {"allotment": int, "sold": int}}
	    (patch migrasi); tanpa seeds → allotment/sold = 0
	:return: nama offer yang dicipta
	"""
	pkg = frappe.get_doc("Travel Package", package)
	data = {
		"doctype": "Package Offer",
		"naming_series": "OFF-.YYYY.-.####",
		"package": pkg.name,
	}
	data.update(values or {})
	offer = frappe.get_doc(data)

	# Salin matriks harga templat → offer (override per-offer kemudian)
	for t in (pkg.price_template or []):
		if not t.active:
			continue
		offer.append("prices", {
			"price_key": t.price_key,
			"opt1": t.opt1, "opt2": t.opt2, "opt3": t.opt3,
			"age_option": t.age_option,
			"currency": t.currency or pkg.default_currency,
			"price": t.price,
			"active": 1,
		})

	# Jana inventori per kombinasi paksi inventory — salin harga templat yang
	# sepadan JUGA sediakan allotment/sold dari seeds (patch migrasi)
	seeds = inventory_seeds or {}
	for key in inventory_keys_for(pkg):
		seed = seeds.get(key, {})
		offer.append("inventory", {
			"inventory_key": key,
			"allotment": int(seed.get("allotment") or 0),
			"sold": int(seed.get("sold") or 0),
		})

	# Komponen selesai — cruise_tour + flight (kalau ada)
	trip = None
	for c in (pkg.components or []):
		if c.component_type == "cruise_tour":
			trip = c.trip
	offer.append("components", {
		"component_type": "cruise_tour",
		"trip": trip,
		"cruise_schedule": offer.get("cruise_schedule"),
		"resolved_start": offer.departure_date,
		"resolved_end": offer.return_date,
	})
	if offer.get("flight"):
		offer.append("components", {
			"component_type": "flight",
			"flight": offer.flight,
			"resolved_start": offer.departure_date,
			"resolved_end": offer.departure_date,
		})

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
	"""Sold per cabin UNTUK SATU keberangkatan (TGD lama) — kiraan reservasi
	tak-cancelled melalui Booking.trip_date.

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
		SELECT br.room_category AS cat, COUNT(*) AS n
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
		["legacy_tgd", "legacy_trip_package", "package"],
		as_dict=True,
	)
	if not offer:
		frappe.throw(f"Offer {offer_name} not found.", frappe.DoesNotExistError)
	pkg_legacy = frappe.db.get_value(
		"Travel Package", travel_package_name, "legacy_trip_package"
	)
	if not offer.legacy_tgd or not pkg_legacy:
		frappe.throw(
			"Provenance legacy belum lengkap untuk struktur baharu ini "
			"(legacy_tgd / legacy_trip_package kosong). Flag use_package_offers "
			"tidak boleh digunakan untuk offer/pakej ini."
		)
	return offer.legacy_tgd, pkg_legacy


def _selection_needs(selections) -> dict:
	"""Jumlah pax per inventory_key daripada selections wizard.
	pax = main_guests + extra_beds + infants; kabin daripada room_category
	(docname Trip Price Category → category_code → 'cabin:CODE')."""
	needs: dict = {}
	codes: dict = {}
	for s in selections or []:
		rc = s.get("room_category")
		if not rc:
			continue
		if rc not in codes:
			codes[rc] = frappe.db.get_value(
				"Trip Price Category", rc, "category_code"
			) or rc
		key = "cabin:" + codes[rc]
		pax = (int(s.get("main_guests", 0) or 0)
			   + int(s.get("extra_beds", 0) or 0)
			   + int(s.get("infants", 0) or 0))
		needs[key] = needs.get(key, 0) + pax
	return needs


def check_offer_capacity(offer_name: str, selections):
	"""F5 gate kapasiti — LOCK baris Package Offer (SELECT ... FOR UPDATE,
	corak P1/C3) kemudian semak setiap inventory_key ada available cukup.
	Dipanggil SEBELUM aliran legacy confirm_booking; lock kekal sehingga
	transaksi commit — apply_offer_booking() yang seterusnya re-lock baris
	yang sama (re-entrant, tiada deadlock)."""
	frappe.db.sql(
		"SELECT name FROM `tabPackage Offer` WHERE name = %s FOR UPDATE",
		(offer_name,),
	)
	needs = _selection_needs(selections)
	inv = {
		r.inventory_key: r
		for r in frappe.get_all(
			"Offer Inventory", filters={"parent": offer_name},
			fields=["name", "inventory_key", "allotment", "sold"],
		)
	}
	for key, pax in needs.items():
		row = inv.get(key)
		if row is None:
			frappe.throw(f"Kabin '{key}' tiada dalam inventori offer ini.")
		avail = int(row.allotment or 0) - int(row.sold or 0)
		if avail < pax:
			frappe.throw(
				f"{key}: hanya {avail} tempat tersedia (perlukan {pax}). "
				"Sila kurangkan bilangan tetamu atau pilih kabin lain."
			)


def apply_offer_booking(offer_name: str, selections) -> int:
	"""F5 tulis: tolak stok offer (sold += pax) atas LOCK yang sama.
	Panggil SELEPAS booking berjaya dicipta, DALAM transaksi yang sama.
	Kembalikan jumlah pax ditolak."""
	frappe.db.sql(
		"SELECT name FROM `tabPackage Offer` WHERE name = %s FOR UPDATE",
		(offer_name,),
	)
	needs = _selection_needs(selections)
	rows = frappe.get_all(
		"Offer Inventory", filters={"parent": offer_name},
		fields=["name", "inventory_key", "allotment", "sold"],
	)
	by_key = {r.inventory_key: r for r in rows}
	total = 0
	for key, pax in needs.items():
		row = by_key.get(key)
		if row is None:
			continue  # sudah ditolak oleh check_offer_capacity di atas
		new_sold = int(row.sold or 0) + pax
		frappe.db.set_value(
			"Offer Inventory", row.name,
			{"sold": new_sold, "available": int(row.allotment or 0) - new_sold},
			update_modified=False,
		)
		total += pax
	if total:
		offer = frappe.db.get_value(
			"Package Offer", offer_name, ["current_pax"], as_dict=True
		)
		frappe.db.set_value("Package Offer", offer_name,
			"current_pax", int(offer.current_pax or 0) + total,
			update_modified=False)
	return total
